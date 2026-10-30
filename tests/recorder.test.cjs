// Runs the real _runRec code from trashure-fury.html against stubbed game
// globals: a full round, offline queue, retries, opt-out, no personal data.
//   node tests/recorder.test.cjs
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'trashure-fury.html'), 'utf8');
const start = html.indexOf('// ---- Research run recorder ----');
const end = html.indexOf('setTimeout(() => { try { _runRec.drain()', start);
const src = html.slice(start, end);

function makeEnv({ optIn = true, net }) {
  const store = new Map();
  const listeners = {};
  const posted = [];
  const ctx = {
    console, JSON, Math, Date, Map, Set, Promise, Uint8Array, URLSearchParams, Object, Array, Number, String,
    crypto: require('crypto').webcrypto,
    location: { search: '?event=Test-Kiosk' },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    sessionStorage: (() => { const s = new Map(); return { getItem: k => s.get(k) ?? null, setItem: (k, v) => s.set(k, v) }; })(),
    navigator: { maxTouchPoints: 0, getGamepads: () => [] },
    innerWidth: 1366, innerHeight: 768,
    document: { getElementById: id => (id === 'research-input' ? { checked: optIn } : null) },
    setTimeout: () => {},
    fetch: (url, opts) => { try { posted.push(JSON.parse(opts.body)); } catch (e) {} return net(opts); },
    // game globals
    gameTime: 0, localPlayer: { x: 0, z: -118, rotation: 0.19, health: 100, boostEnergy: 1, boatLevel: 1, totalCollected: 0 },
    playerUpgrades: { solar_panel: 0, speed: 0, magnet: 0 },
    respawnActive: false, upgradeActive: false, whaleState: 'surface',
    bots: [{ id: 'bot_0', isHydro: true, x: 144, z: 0, rotation: 1, health: 100 },
           { id: 'whale', isWhale: true, x: 50, z: 50, rotation: 2, health: 500 }],
    pirates: [], garbage: [{ id: 'g_1', x: 75, z: 103, points: 3 }], seaMines: [], bombs: [],
    _mp: null, _currentLang: 'en', _GP_AXIS_LX: 0, _GP_AXIS_LY: 1,
    WORLD_RADIUS: 160, ISLAND_RADIUS: 12, GAME_DURATION: 180, MAX_HEALTH: 100,
    LQ_MODE: false, BACKEND_HTTP: 'http://test', roundStats: { pieces: 0 },
  };
  ctx.window = ctx;
  ctx.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis._runRec = _runRec;', ctx);
  return { ctx, store, posted, listeners };
}

// Simulate `secs` of play at 60 fps.
function play(env, secs, mutate) {
  const { ctx } = env;
  const input = { forward: true, left: false };
  for (let i = 0; i < secs * 60; i++) {
    ctx.gameTime += 1 / 60;
    ctx.localPlayer.z += 0.1;
    input.left = (i % 120) < 30;
    if (mutate) mutate(ctx, i);
    ctx._runRec.tick(input, input);
  }
}
const flushMicro = () => new Promise(r => setImmediate(r));
const ok = { ok: true, status: 200 };
let failures = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) failures++; };

(async () => {
  // 1. Full round online: 180 s → 12 chunks, last one complete.
  {
    const env = makeEnv({ net: () => Promise.resolve(ok) });
    env.ctx.localPlayer.totalCollected = 4242;
    env.ctx.roundStats.pieces = 7;
    play(env, 180, (c, i) => {
      if (i === 600) c.garbage.length = 0;                       // plastic collected
      if (i === 900) c.bombs.push({ id: 'bomb_0', targetX: 1, targetZ: 2, originX: 3, originZ: 4 });
      if (i === 960) c.bombs.length = 0;
      if (i === 1200) c.playerUpgrades.speed = 1;
    });
    env.ctx._runRec.finish('complete');
    for (let i = 0; i < 40; i++) await flushMicro();
    const p = env.posted;
    const seqs = p.map(c => c.seq);
    check('online: 12 chunks posted (11 x 15 s + final)', p.length === 12, 'seqs=' + seqs.join(','));
    check('online: header only on seq 0', !!p[0].hdr && p.slice(1).every(c => !c.hdr));
    check('online: event tag from URL, lowercased', p[0].hdr.event === 'test-kiosk');
    check('online: last chunk fin + complete', p[p.length - 1].fin && p[p.length - 1].end.reason === 'complete');
    const frames = p.reduce((n, c) => n + c.f.length, 0), obs = p.reduce((n, c) => n + c.o.length, 0);
    check('online: ~10 Hz frames', frames >= 1780 && frames <= 1810, 'frames=' + frames);
    check('online: ~5 Hz obs', obs >= 890 && obs <= 910, 'obs=' + obs);
    const ev = p.flatMap(c => c.e).map(e => e[0]);
    check('online: g+ g- x+ x- up ent events', ['g+', 'g-', 'x+', 'x-', 'up', 'ent'].every(k => ev.includes(k)));
    check('online: queue empty after success', !env.store.get('ti_run_pending'));
    const sizes = p.map(c => JSON.stringify(c).length);
    check('online: every chunk < 60 KB (keepalive)', Math.max(...sizes) < 60000, 'max=' + Math.max(...sizes));
    check('online: no name/email anywhere', !JSON.stringify(p).match(/email|Capitaine/));
    check('online: no score anywhere', !JSON.stringify(p).includes('score') && p.flatMap(c => c.f).every(f => f[7] !== 4242));
    check('online: pieces recorded instead', p[p.length - 1].end.pieces === 7 && p[p.length - 1].f.at(-1)[7] === 7);
    check('online: hour-rounded start', p[0].hdr.hour % 3600000 === 0);
    // finishing twice / ticking after finish does nothing
    env.ctx._runRec.finish('complete'); play(env, 1);
    check('online: nothing after finish', env.posted.length === 12);
  }
  // 2. Offline: network down → chunks stay in localStorage, then drain once back.
  {
    let up = false;
    const env = makeEnv({ net: () => (up ? Promise.resolve(ok) : Promise.reject(new Error('offline'))) });
    play(env, 40);
    for (let i = 0; i < 20; i++) await flushMicro();
    const q = JSON.parse(env.store.get('ti_run_pending') || '[]');
    check('offline: 2 chunks queued', q.length === 2, 'queued=' + q.length);
    up = true;
    env.ctx._runRec.drain();
    for (let i = 0; i < 20; i++) await flushMicro();
    check('offline: queue drained when back online', !env.store.get('ti_run_pending'));
  }
  // 3. 5xx keeps, 4xx drops.
  {
    let status = 503;
    const env = makeEnv({ net: () => Promise.resolve({ ok: status < 300, status }) });
    play(env, 16);
    for (let i = 0; i < 20; i++) await flushMicro();
    check('5xx: chunk kept', JSON.parse(env.store.get('ti_run_pending') || '[]').length === 1);
    status = 400; env.ctx._runRec.drain();
    for (let i = 0; i < 20; i++) await flushMicro();
    check('4xx: chunk dropped', !env.store.get('ti_run_pending'));
  }
  // 4. Abandon mid-round → fin chunk 'abandoned', queued AND posted directly.
  {
    const env = makeEnv({ net: () => Promise.resolve(ok) });
    play(env, 20);
    env.ctx._runRec.abandon();
    for (let i = 0; i < 20; i++) await flushMicro();
    const last = env.posted[env.posted.length - 1];
    check('abandon: last chunk abandoned', last.fin && last.end.reason === 'abandoned');
  }
  // 5. Opt-out: nothing recorded or sent.
  {
    const env = makeEnv({ optIn: false, net: () => Promise.resolve(ok) });
    play(env, 40);
    env.ctx._runRec.finish('complete');
    check('opt-out: nothing posted', env.posted.length === 0 && !env.store.get('ti_run_pending'));
  }
  // 6. Queue cap: oldest dropped past ~3 MB.
  {
    const env = makeEnv({ net: () => Promise.reject(new Error('offline')) });
    const big = 'x'.repeat(700000);
    env.store.set('ti_run_pending', JSON.stringify([big, big, big, big]));
    play(env, 16);
    for (let i = 0; i < 20; i++) await flushMicro();
    const q = JSON.parse(env.store.get('ti_run_pending'));
    const total = q.reduce((n, s) => n + s.length, 0);
    check('cap: queue stays under 3 MB, newest kept', total <= 3000000 && q[q.length - 1].startsWith('{'), 'items=' + q.length + ' total=' + total);
  }
  console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();
