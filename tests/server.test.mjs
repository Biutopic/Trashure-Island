// Integration test for party/main.ts. Start the server first:
//   cd party && npx wrangler dev --port 8787
//   node tests/server.test.mjs
const HTTP = 'http://127.0.0.1:8787/parties/main';
const WS = 'ws://127.0.0.1:8787/parties/main/global';
let failures = 0;
const check = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) failures++; };
const post = (room, body, type = 'application/json') => fetch(`${HTTP}/${room}`, { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (room, qs = '') => fetch(`${HTTP}/${room}${qs}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- routing + CORS ---
{
  const r = await fetch('http://127.0.0.1:8787/nope');
  check('unknown path 404', r.status === 404);
  const o = await fetch(`${HTTP}/consents`, { method: 'OPTIONS', headers: { Origin: 'https://biutopic.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  check('CORS preflight', o.status === 204 && o.headers.get('access-control-allow-origin') === '*', 'status=' + o.status);
  const g = await get('consents');
  check('CORS on GET', g.headers.get('access-control-allow-origin') === '*');
}
// --- consents / scores / leaderboard ---
{
  const stamp = Date.now();
  const email = `t${stamp}@example.org`;
  let r = await post('consents', { email: 'bad', consent: true });
  check('consent: bad email 400', r.status === 400);
  r = await post('consents', { email, consent: false });
  check('consent: no consent 400', r.status === 400);
  r = await post('consents', { email, consent: true, name: 'Portside', lang: 'fr', ua: 'test' });
  check('consent: stored', r.status === 200 && (await r.json()).ok);
  r = await post('consents', { kind: 'score', name: 'Portside', score: 4242, email, consent: true });
  check('score: stored', r.status === 200 && (await r.json()).ok);
  r = await post('consents', { kind: 'score', name: 'Portside', score: 4242, email, consent: true });
  check('score: 60 s dedup', (await r.json()).dedup === true);
  r = await post('consents', { kind: 'score', name: 'Portside', score: 10, email: '', consent: true });
  check('score: no email 400', r.status === 400);
  const top = await (await get('consents', '?action=top&limit=5')).json();
  check('leaderboard: score listed', top.rows.some(x => x.name === 'Portside' && x.score === 4242), JSON.stringify(top.rows[0]));
  check('leaderboard: no email exposed', !JSON.stringify(top).includes('@'));
  r = await get('consents', '?action=admin&token=wrong');
  check('admin: wrong token 403', r.status === 403);
  const adm = await (await get('consents', '?action=admin&token=localtest')).json();
  check('admin: returns consent + reject records', adm.ok && adm.consents.some(c => c.email === email) && adm.rejects.length > 0, `consents=${adm.consents.length} rejects=${adm.rejects.length}`);
}
// --- runs ---
{
  const rid = 'portrun' + Date.now().toString(36);
  let r = await post('runs', 'nope', 'text/plain');
  check('runs: bad json 400', r.status === 400);
  r = await post('runs', { kind: 'run', v: 1, rid: 'X!', seq: 0, f: [], o: [], e: [] }, 'text/plain');
  check('runs: bad rid 400', r.status === 400);
  r = await post('runs', { kind: 'run', v: 1, rid, seq: 0, fin: false, hdr: { mode: 'solo' }, f: [[0, 1]], o: [], e: [], email: 'leak@x.com' }, 'text/plain');
  check('runs: chunk stored', r.status === 200);
  r = await post('runs', { kind: 'run', v: 1, rid, seq: 0, fin: false, hdr: { mode: 'solo' }, f: [[0, 9]], o: [], e: [] }, 'text/plain');
  r = await post('runs', { kind: 'run', v: 1, rid, seq: 1, fin: true, end: { reason: 'complete' }, f: [], o: [], e: [] }, 'text/plain');
  r = await post('runs', 'x'.repeat(120000), 'text/plain');
  check('runs: too big 413', r.status === 413);
  check('runs: no token 403', (await get('runs', '?action=runs_export')).status === 403);
  const rows = []; let after = '';
  for (;;) {
    const p = await (await get('runs', `?action=runs_export&token=localtest&limit=1${after ? '&after=' + after : ''}`)).json();
    rows.push(...p.rows); if (!p.next) break; after = p.next;
  }
  const mine = rows.filter(x => x.rid === rid);
  check('runs: paged export finds both chunks', mine.length === 2, 'total rows=' + rows.length);
  check('runs: re-post overwrote', mine[0].f[0][1] === 9);
  check('runs: unknown field stripped', !JSON.stringify(mine).includes('leak@'));
  check('runs: receive time rounded to the hour', mine[0].at % 3600000 === 0);
  const adm = await (await get('consents', '?action=admin&token=localtest')).json();
  check('runs: separate storage from consents', !JSON.stringify(adm).includes(rid));
}
// --- multiplayer websocket ---
function client(pid) {
  const ws = new WebSocket(`${WS}?pid=${pid}`);
  const c = { ws, types: {}, msgs: [] };
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); c.types[m.type] = (c.types[m.type] || 0) + 1; c.msgs.push(m); });
  c.open = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  c.send = o => ws.send(JSON.stringify(o));
  c.last = t => c.msgs.filter(m => m.type === t).at(-1);
  return c;
}
{
  const pa = 'alpha' + Date.now(), pb = 'bravo' + Date.now();
  const a = client(pa), b = client(pb);
  await Promise.all([a.open, b.open]);
  await sleep(1500);
  check('ws: both clients get state + snapshots', a.types.state > 0 && b.types.state > 0 && a.types.g_snap > 0, JSON.stringify(a.types));
  const st = a.last('state').state;
  const seats = st.seats.filter(s => s.kind === 'human');
  check('ws: 2 human seats, ids from connections', seats.length === 2 && seats.every(s => s.id && s.pid), `phase=${st.phase}`);
  check('ws: pid read from connect URL', seats.some(s => s.pid === pa) && seats.some(s => s.pid === pb));
  // Server skips poses when nothing moved, so drive a moving boat for 2 s.
  const before = a.types.poses || 0;
  for (let i = 0; i < 20; i++) { b.send({ type: 'boat', x: i, z: 5, rot: 0.5, b: 0, h: 100 }); await sleep(100); }
  const rate = ((a.types.poses || 0) - before) / 2;
  check('ws: 10 Hz ticker fans out poses', rate >= 7, `${rate} poses/s`);
  // pose relay: b sends its boat, a sees it in poses
  const posesSeen = () => a.msgs.filter(m => JSON.stringify(m).includes('"x":77'));
  b.send({ type: 'boat', x: 77, z: 11, rot: 1, b: 0, h: 100 });
  await sleep(800);
  check('ws: boat pose relayed to other client', posesSeen().length > 0);
  // reconnect with same pid keeps the seat
  const seatB = a.last('state').state.seats.findIndex(s => s.pid === pb);
  b.ws.close();
  await sleep(500);
  const b2 = client(pb);
  await b2.open; await sleep(1000);
  const st2 = a.last('state').state;
  check('ws: reconnect keeps seat by pid', st2.seats.findIndex(s => s.pid === pb) === seatB && st2.seats.filter(s => s.kind === 'human').length === 2);
  b2.ws.close(); a.ws.close();
  await sleep(500);
  // Rooms are independent: the empty room must have stopped cleanly and accept a new player.
  const c = client('charlie' + Date.now());
  await c.open; await sleep(1000);
  check('ws: room accepts a player after emptying', c.types.state > 0);
  c.ws.close();
}
console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
