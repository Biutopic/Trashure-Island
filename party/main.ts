// Trashure Island — PartyKit room server.
//
// Milestone 1 + 1.5 scope: lobby + round state machine + Ready button.
// Up to 4 human seats per room; empty seats are placeholder "bot" seats
// so the leaderboard is always 4-wide. A later milestone will network
// the full world state (pirates, garbage, combat).
//
// Deploy:  npx partykit deploy
// Dev:     npx partykit dev
//
// Client opens:  wss://trashure-island.<username>.partykit.dev/parties/main/<roomId>
// Rooms are segregated by path; v1 always uses roomId="global" so every
// player lands in the same ocean. Custom room codes can be added later.

import type * as Party from "partykit/server";

type Phase = "LOBBY" | "COUNTDOWN" | "PLAYING" | "RECAP";

type Seat =
  | { kind: "empty" }
  | {
      kind: "human";
      id: string;
      pid: string;
      name: string;
      ready: boolean;
      color: string;
      lastSeenAt: number;
      // Live boat pose — updated from client 'boat' messages at ~10 Hz,
      // broadcast in every state snapshot so other clients can render
      // the other captains moving around.
      x: number;
      z: number;
      rot: number;
      boosting: boolean; // fresh every boat message; drives turbo-smoke fx
      // Shared, server-authoritative health. Damage events route
      // through the room so both the attacker and victim see the
      // same result.
      health: number;
      maxHealth: number;
      // Invulnerability window after a hit (epoch ms) — server rejects
      // additional damage before this to match the client's INVULN_AFTER_HIT.
      invulnUntil: number;
      // Cumulative pickup count this round.
      score: number;
    }
  | { kind: "bot"; name: string; color: string };

// If we haven't heard from a human seat in this long, treat it as a
// ghost (browser crash, stuck connection, no close frame) and flip
// it back to a bot so the round state stays honest. Longer than the
// client's 3s ping cadence so backgrounded tabs (whose pings go via
// a Web Worker to escape throttling) survive a transient hiccup.
const GHOST_TIMEOUT_MS = 15_000;

type Garbage = {
  id: number;         // short numeric id, keeps wire tiny
  x: number;
  z: number;
  kind: 0 | 1;        // 0 = plastic, 1 = pink-heal
  claimed: boolean;
};

// --- Shared world entities (pirates, whale, hydronaute, mines, bombs) ---
// All of these are server-spawned during PLAYING and streamed to every
// client alongside player poses. The client renders them and still runs
// damage-to-self logic locally (self-reports HP via the boat message),
// but their positions come from the server.
type Pirate = {
  id: number;
  x: number;
  z: number;
  rot: number;
  health: number;
  emerged: boolean;       // true once the rise animation finished
  emergeAt: number;       // epoch ms when they finish emerging
  diveAt: number;         // epoch ms when they next dive
  resurfaceAt: number;    // epoch ms when they re-emerge after a dive
  targetSeat: number;     // seat index the pirate is chasing, -1 if none
  lastBombAt: number;
  lastMineAt: number;
};
type Whale = {
  x: number;
  z: number;
  rot: number;
  state: "submerged" | "surfacing" | "surface" | "diving";
  nextStateAt: number;
};
type Hydro = {
  x: number;
  z: number;
  rot: number;
  waypointIdx: number;
};
type Mine = {
  id: number;
  x: number;
  z: number;
  armedAt: number;   // epoch ms when it becomes live
};
type Bomb = {
  id: number;
  x: number;
  z: number;
  targetX: number;
  targetZ: number;
  originX: number;
  originZ: number;
  startAt: number;
  endAt: number;
  piId: number;        // owning pirate id
};

interface RoomState {
  phase: Phase;
  // Epoch ms when the current phase ends. Server-authoritative — the
  // client renders the countdown by subtracting Date.now().
  phaseEndsAt: number;
  // Fixed 4-slot grid. Seat index is stable for a given round so the
  // leaderboard layout doesn't jump when someone joins or leaves.
  seats: Seat[];
}

// Phase durations (ms)
// LOBBY has no auto-timeout: rounds only start when every human clicks
// READY. The server sets phaseEndsAt to a "quick start" value once the
// last human readies up, used only for the ~1.5 s settle before the 3-2-1.
const QUICK_START_MS   = 10_000; // 10s grace after all humans ready
const COUNTDOWN_MS     = 3_000;
const PLAYING_MS       = 180_000; // 3 minutes
const RECAP_MS         = 15_000;
const TICK_MS          = 100;     // 10 Hz. Halved from 20 Hz to keep bandwidth low — client-side snapshot interpolation fills the gap smoothly.
const MIN_HUMANS_TO_START = 2;    // solo lobby never advances: use "Play offline" on the client
const MAX_HEALTH_SERVER   = 100;  // match client MAX_HEALTH
const HIT_INVULN_MS       = 700;  // match client INVULN_AFTER_HIT (0.7s)

// Shared garbage field. Keep the counts modest so the per-tick wire
// + initial snapshot stay cheap.
const MAX_GARBAGE          = 50;   // enough to keep the ocean stocked for 2+ players
const GARBAGE_WORLD_RADIUS = 155;  // slightly inside the client WORLD_RADIUS (160)
const GARBAGE_ISLAND_PAD   = 18;
const GARBAGE_SPAWN_MS     = 700;  // ~1.4 Hz — faster restock
const PINK_CHANCE          = 0.10; // fraction of spawns that heal
const MAX_DEATH_DROP       = 6;    // cap per-sink drop so a chain of deaths doesn't flood

// World entities
const PIRATE_FIRST_SPAWN_MS = 45_000;   // ~45 s into a round
const PIRATE_MAX            = 3;
const PIRATE_HP_FULL        = 100;
const PIRATE_SPEED          = 6;
const PIRATE_EMERGE_MS      = 2_500;
const PIRATE_DIVE_INTERVAL  = 60_000;
const PIRATE_DIVE_DURATION  = 10_000;
const PIRATE_BOMB_INTERVAL  = 5_000;
const PIRATE_MINE_INTERVAL  = 30_000;
const BOMB_FLIGHT_MS        = 1_200;
const WHALE_SPAWN_MS        = 25_000;
const WHALE_CYCLE_MS        = 60_000;   // full submerged -> surface -> submerged cycle
const HYDRO_SPAWN_MS        = 10_000;
const HYDRO_SPEED           = 4.0;

const COLORS    = ["#ff5a3c", "#ffd93d", "#4ade80", "#22d3ee"];

function makeEmptySeats(): Seat[] {
  // Online multiplayer is humans-only. Unfilled slots stay visibly
  // empty in the lobby and produce no AI boat in the round.
  return [{ kind: "empty" }, { kind: "empty" }, { kind: "empty" }, { kind: "empty" }];
}

function initialState(): RoomState {
  return {
    phase: "LOBBY",
    // 0 = no countdown armed. Server arms it only when all humans are ready.
    phaseEndsAt: 0,
    seats: makeEmptySeats(),
  };
}

// Lobby short-circuit: at least MIN_HUMANS_TO_START humans AND all of
// them have clicked Ready. Solo humans are intentionally excluded so
// the countdown never fires for a one-player lobby — they should hit
// "Play offline" instead.
function allHumansReady(state: RoomState): boolean {
  const humans = state.seats.filter((s) => s.kind === "human") as Extract<Seat, { kind: "human" }>[];
  if (humans.length < MIN_HUMANS_TO_START) return false;
  return humans.every((h) => h.ready);
}

function humanCount(state: RoomState): number {
  return state.seats.filter((s) => s.kind === "human").length;
}

export default class TrashureRoom implements Party.Server {
  state: RoomState;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  // Shared garbage field. Not stored on state because it's large +
  // has its own lifecycle (spawn / claim / despawn); we broadcast
  // deltas via dedicated messages rather than repacking full state.
  private garbage: Garbage[] = [];
  private garbageNextId = 1;
  private garbageSpawnAcc = 0;

  // World — lifecycle tied to PLAYING.
  private pirates: Pirate[] = [];
  private pirateNextId = 1;
  private mines: Mine[] = [];
  private mineNextId = 1;
  private bombs: Bomb[] = [];
  private bombNextId = 1;
  private whale: Whale | null = null;
  private hydro: Hydro | null = null;
  private roundStartedAt = 0;

  constructor(readonly room: Party.Room) {
    this.state = initialState();
  }

  // --- GARBAGE ---
  private spawnGarbageAround() {
    // Pick a spot in the annulus between the island pad and world edge.
    const a = Math.random() * Math.PI * 2;
    const r = GARBAGE_ISLAND_PAD + Math.random() * (GARBAGE_WORLD_RADIUS - GARBAGE_ISLAND_PAD);
    const g: Garbage = {
      id: this.garbageNextId++,
      x: Math.round((Math.cos(a) * r) * 100) / 100,
      z: Math.round((Math.sin(a) * r) * 100) / 100,
      kind: Math.random() < PINK_CHANCE ? 1 : 0,
      claimed: false,
    };
    this.garbage.push(g);
    this.room.broadcast(JSON.stringify({ type: "g_add", items: [{ id: g.id, x: g.x, z: g.z, k: g.kind }] }));
  }
  private ensureGarbageField() {
    // Initial fill when a round starts.
    while (this.garbage.length < MAX_GARBAGE) this.spawnGarbageAround();
  }
  private clearGarbageField() {
    this.garbage.length = 0;
    this.room.broadcast(JSON.stringify({ type: "g_reset" }));
  }
  private tickGarbage(dt: number) {
    if (this.state.phase !== "PLAYING") return;
    this.garbageSpawnAcc += dt;
    while (this.garbageSpawnAcc >= GARBAGE_SPAWN_MS && this.garbage.length < MAX_GARBAGE) {
      this.garbageSpawnAcc -= GARBAGE_SPAWN_MS;
      this.spawnGarbageAround();
    }
  }
  // Send the full garbage field to one connection (used on connect).
  private sendGarbageSnapshot(conn: Party.Connection) {
    const items = this.garbage.map(g => ({ id: g.id, x: g.x, z: g.z, k: g.kind }));
    try { conn.send(JSON.stringify({ type: "g_snap", items })); } catch {}
  }

  // --- WORLD ---
  private resetWorld() {
    this.pirates = [];
    this.mines = [];
    this.bombs = [];
    this.whale = null;
    this.hydro = null;
    this.pirateNextId = 1;
    this.mineNextId = 1;
    this.bombNextId = 1;
  }
  private spawnPirate(): Pirate {
    const a = Math.random() * Math.PI * 2;
    const r = 90 + Math.random() * 50;
    const now = Date.now();
    return {
      id: this.pirateNextId++,
      x: Math.round(Math.cos(a) * r * 100) / 100,
      z: Math.round(Math.sin(a) * r * 100) / 100,
      rot: Math.random() * Math.PI * 2,
      health: PIRATE_HP_FULL,
      emerged: false,
      emergeAt: now + PIRATE_EMERGE_MS,
      diveAt: now + PIRATE_DIVE_INTERVAL + Math.random() * 10_000,
      resurfaceAt: 0,
      targetSeat: -1,
      lastBombAt: now + 3000 + Math.random() * 2000,
      lastMineAt: now + 15000 + Math.random() * 10000,
    };
  }
  private nearestHumanSeat(x: number, z: number): number {
    let best = -1, bestD2 = Infinity;
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind !== "human") continue;
      const dx = s.x - x, dz = s.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    return best;
  }
  private tickWorld(dtMs: number) {
    if (this.state.phase !== "PLAYING") return;
    const now = Date.now();
    const elapsed = now - this.roundStartedAt;
    const dt = dtMs / 1000;

    // Spawn pirates staggered: first at PIRATE_FIRST_SPAWN_MS, then
    // one each ~60 s thereafter up to PIRATE_MAX.
    const want = Math.min(PIRATE_MAX, Math.max(0, Math.floor((elapsed - PIRATE_FIRST_SPAWN_MS) / 60_000) + 1));
    while (this.pirates.length < want) {
      const p = this.spawnPirate();
      this.pirates.push(p);
      this.room.broadcast(JSON.stringify({ type: "p_add", p: this.pirateWire(p) }));
    }

    // Whale spawns once at WHALE_SPAWN_MS and cycles surface/submerge.
    if (!this.whale && elapsed >= WHALE_SPAWN_MS) {
      const a = Math.random() * Math.PI * 2;
      this.whale = {
        x: Math.cos(a) * 80, z: Math.sin(a) * 80,
        rot: Math.random() * Math.PI * 2,
        state: "submerged",
        nextStateAt: now + 8000,
      };
      this.room.broadcast(JSON.stringify({ type: "whale", w: this.whaleWire() }));
    }
    if (this.whale && now >= this.whale.nextStateAt) {
      const seq: Whale["state"][] = ["submerged","surfacing","surface","diving"];
      const cur = seq.indexOf(this.whale.state);
      this.whale.state = seq[(cur + 1) % 4];
      const dur = this.whale.state === "submerged" ? WHALE_CYCLE_MS * 0.5
                : this.whale.state === "surfacing" ? 2500
                : this.whale.state === "surface"   ? WHALE_CYCLE_MS * 0.25
                : 2500;
      this.whale.nextStateAt = now + dur;
      // When she emerges, pick a new wander target.
      if (this.whale.state === "surfacing") {
        const a = Math.random() * Math.PI * 2;
        this.whale.x = Math.cos(a) * 70 + (Math.random() - 0.5) * 40;
        this.whale.z = Math.sin(a) * 70 + (Math.random() - 0.5) * 40;
        this.whale.rot = Math.random() * Math.PI * 2;
      }
      this.room.broadcast(JSON.stringify({ type: "whale", w: this.whaleWire() }));
    }

    // Hydronaute spawns once and orbits slowly.
    if (!this.hydro && elapsed >= HYDRO_SPAWN_MS) {
      this.hydro = { x: 130, z: 0, rot: Math.PI, waypointIdx: 0 };
      this.room.broadcast(JSON.stringify({ type: "hydro", h: this.hydroWire() }));
    }
    if (this.hydro) {
      // Simple orbit around world origin.
      const tAngle = Math.atan2(this.hydro.z, this.hydro.x) + dt * 0.15;
      const r = 125;
      this.hydro.x = Math.cos(tAngle) * r;
      this.hydro.z = Math.sin(tAngle) * r;
      this.hydro.rot = tAngle + Math.PI / 2;
    }

    // Pirates: chase + bomb + mine. Simple AI.
    for (const p of this.pirates) {
      if (!p.emerged && now >= p.emergeAt) p.emerged = true;
      if (!p.emerged) continue;

      // Periodic dive cycle
      if (now >= p.diveAt) {
        // Hide for PIRATE_DIVE_DURATION, then resurface elsewhere.
        const a = Math.random() * Math.PI * 2;
        const r = 90 + Math.random() * 50;
        p.x = Math.cos(a) * r; p.z = Math.sin(a) * r;
        p.emerged = false;
        p.emergeAt  = now + PIRATE_DIVE_DURATION + PIRATE_EMERGE_MS;
        p.diveAt    = now + PIRATE_DIVE_DURATION + PIRATE_DIVE_INTERVAL;
      }

      // Pick / refresh target
      if (p.targetSeat === -1 || Math.random() < 0.02) {
        p.targetSeat = this.nearestHumanSeat(p.x, p.z);
      }
      const tgt = p.targetSeat >= 0 ? this.state.seats[p.targetSeat] : null;
      if (tgt && tgt.kind === "human") {
        // Steer toward target
        const dx = tgt.x - p.x, dz = tgt.z - p.z;
        const wantA = Math.atan2(dx, dz);
        let diff = wantA - p.rot;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        p.rot += Math.max(-1, Math.min(1, diff)) * dt * 1.5;
      }
      p.x += Math.sin(p.rot) * PIRATE_SPEED * dt;
      p.z += Math.cos(p.rot) * PIRATE_SPEED * dt;
      // Keep inside world
      const d = Math.hypot(p.x, p.z);
      if (d > 140) { p.x = (p.x / d) * 140; p.z = (p.z / d) * 140; }

      // Bombs — lobbed at the nearest human.
      if (now >= p.lastBombAt && tgt && tgt.kind === "human") {
        const dxB = tgt.x - p.x, dzB = tgt.z - p.z;
        if (dxB * dxB + dzB * dzB < 60 * 60) {
          const b: Bomb = {
            id: this.bombNextId++,
            x: p.x, z: p.z,
            originX: p.x, originZ: p.z,
            targetX: tgt.x + (Math.random() - 0.5) * 3,
            targetZ: tgt.z + (Math.random() - 0.5) * 3,
            startAt: now, endAt: now + BOMB_FLIGHT_MS,
            piId: p.id,
          };
          this.bombs.push(b);
          this.room.broadcast(JSON.stringify({ type: "b_add", b: this.bombWire(b) }));
          p.lastBombAt = now + PIRATE_BOMB_INTERVAL * (0.6 + Math.random() * 0.8);
        }
      }

      // Mines — dropped behind every so often
      if (now >= p.lastMineAt) {
        const behind = 4;
        const mx = p.x - Math.sin(p.rot) * behind;
        const mz = p.z - Math.cos(p.rot) * behind;
        const m: Mine = { id: this.mineNextId++, x: mx, z: mz, armedAt: now + 800 };
        this.mines.push(m);
        this.room.broadcast(JSON.stringify({ type: "m_add", m: this.mineWire(m) }));
        p.lastMineAt = now + PIRATE_MINE_INTERVAL * (0.7 + Math.random() * 0.6);
      }
    }

    // Resolve bombs that reached their target (explosion — clients render it;
    // damage-to-self still handled by the victim's client via self-report HP).
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      if (now >= b.endAt) {
        this.bombs.splice(i, 1);
        this.room.broadcast(JSON.stringify({ type: "b_exp", id: b.id, x: b.targetX, z: b.targetZ }));
      }
    }
  }

  // Wire-level projections — keep payloads small.
  private pirateWire(p: Pirate) {
    return {
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      r: Math.round(p.rot * 1000) / 1000,
      h: p.health | 0,
      e: p.emerged ? 1 : 0,
    };
  }
  private whaleWire() {
    if (!this.whale) return null;
    return {
      x: Math.round(this.whale.x * 100) / 100,
      z: Math.round(this.whale.z * 100) / 100,
      r: Math.round(this.whale.rot * 1000) / 1000,
      s: this.whale.state,
    };
  }
  private hydroWire() {
    if (!this.hydro) return null;
    return {
      x: Math.round(this.hydro.x * 100) / 100,
      z: Math.round(this.hydro.z * 100) / 100,
      r: Math.round(this.hydro.rot * 1000) / 1000,
    };
  }
  private mineWire(m: Mine) { return { id: m.id, x: m.x, z: m.z }; }
  private bombWire(b: Bomb) {
    return {
      id: b.id,
      ox: Math.round(b.originX * 100) / 100,
      oz: Math.round(b.originZ * 100) / 100,
      tx: Math.round(b.targetX * 100) / 100,
      tz: Math.round(b.targetZ * 100) / 100,
      s: b.startAt, e: b.endAt,
    };
  }
  // Snapshot of world for a fresh client: one message with everything.
  private sendWorldSnapshot(conn: Party.Connection) {
    const msg = {
      type: "w_snap",
      pirates: this.pirates.map(p => this.pirateWire(p)),
      mines:   this.mines.map(m => this.mineWire(m)),
      bombs:   this.bombs.map(b => this.bombWire(b)),
      whale:   this.whaleWire(),
      hydro:   this.hydroWire(),
    };
    try { conn.send(JSON.stringify(msg)); } catch {}
  }

  private startTicker() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick();
      this.tickGarbage(TICK_MS);
      this.tickWorld(TICK_MS);
      this.broadcastIfPlaying();
    }, TICK_MS);
  }
  private stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  // ---- lifecycle ----
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // Client sends a persistent id in the WS URL query. On reconnect
    // (e.g. short network drop), we match on pid and re-seat the same
    // player instead of letting a ghost seat pile up.
    let pid = "";
    try { pid = new URL(ctx.request.url).searchParams.get("pid") || ""; } catch {}

    if (pid) {
      const existingIdx = this.state.seats.findIndex(
        (s) => s.kind === "human" && (s as any).pid === pid
      );
      if (existingIdx !== -1) {
        const seat = this.state.seats[existingIdx] as Extract<Seat, { kind: "human" }>;
        seat.id = conn.id;
        seat.ready = false; // don't carry over stale ready on reconnect
        seat.lastSeenAt = Date.now();
        // keep last known x/z/rot so the boat doesn't teleport on brief drops
        this.startTicker();
        this.broadcastState();
        return;
      }
    }

    // Opportunistic cleanup: flush any ghost seats whose last activity
    // is older than GHOST_TIMEOUT_MS before we seat the new player.
    // Saves late joiners from landing in a lobby full of zombies.
    this.reapGhostSeats();

    // Mid-round joining is allowed: the player takes the first free
    // seat. Spectator only when all 4 seats are already human.
    const idx = this.state.seats.findIndex((s) => s.kind === "empty");
    if (idx === -1) {
      conn.send(JSON.stringify({ type: "spectator" }));
      conn.send(JSON.stringify({ type: "state", state: this.state }));
      return;
    }
    // Color is stable per seat index so the lobby grid doesn't reshuffle.
    const color = COLORS[idx % COLORS.length];
    this.state.seats[idx] = { kind: "human", id: conn.id, pid, name: "Capitaine", ready: false, color, lastSeenAt: Date.now(), x: 0, z: 0, rot: 0, boosting: false, health: MAX_HEALTH_SERVER, maxHealth: MAX_HEALTH_SERVER, invulnUntil: 0, score: 0 };
    this.startTicker();
    this.broadcastState();
    // If a round is already in flight, sync the joiner's world + garbage.
    if (this.state.phase === "PLAYING") {
      this.sendGarbageSnapshot(conn);
      this.sendWorldSnapshot(conn);
    }
  }

  onMessage(msg: string, conn: Party.Connection) {
    let data: any;
    try { data = JSON.parse(msg); } catch { return; }

    const seat = this.findSeatByConn(conn.id);
    // Refresh the heartbeat on ANY message from this seat. The client
    // sends a ping every few seconds to keep this fresh even when idle.
    if (seat?.kind === "human") seat.lastSeenAt = Date.now();

    if (data.type === "ping") {
      // Heartbeat only; no state change, no broadcast.
      return;
    }

    // Resync: client realized its garbage view may have drifted (e.g.
    // after a death / respawn). Reply with a fresh snapshot containing
    // the exact current server field, and the client will reset and
    // rebuild to match.
    if (data.type === "g_resync") {
      this.sendGarbageSnapshot(conn);
      return;
    }

    if (data.type === "boat" && seat?.kind === "human") {
      const x = Number(data.x), z = Number(data.z), r = Number(data.rot);
      if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(r)) {
        seat.x = x; seat.z = z; seat.rot = r;
      }
      seat.boosting = !!data.b;
      // Self-reported health. The client is authoritative for its
      // own HP display — it already knows about pirate damage, mine
      // hits, island collisions, pink pickups, respawns, everything.
      // Combat hits from other players still go through the 'hit'
      // path (attacker reports victim seat + dmg; server validates
      // invuln window and broadcasts), so that stays authoritative.
      // The trade-off: a malicious client could lie about its own
      // HP, but scoring (plastic pickups) is server-authoritative so
      // the worst they can do is refuse to die, not inflate score.
      if (typeof data.h === "number" && Number.isFinite(data.h)) {
        seat.health = Math.max(0, Math.min(seat.maxHealth, data.h | 0));
      }
      return;
    }

    // Fireball spawn: attacker client fires locally, we just relay the
    // spawn pose to everyone else so they can render a visual-only
    // fireball. Damage still rides through the 'hit' event.
    if (data.type === "fire") {
      const attackerSeat = this.findSeatByConn(conn.id);
      if (!attackerSeat || attackerSeat.kind !== "human") return;
      const attackerIdx = this.state.seats.indexOf(attackerSeat);
      const out = {
        type: "fire",
        attacker: attackerIdx,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        z: Number(data.z) || 0,
        vx: Number(data.vx) || 0,
        vz: Number(data.vz) || 0,
        charge: Math.max(0, Math.min(1, Number(data.charge) || 0)),
      };
      this.room.broadcast(JSON.stringify(out), [conn.id]); // skip sender
      return;
    }

    // Pickup claim: a player reports they drove into a piece of garbage.
    // We validate (piece exists, unclaimed, distance sanity, seat exists),
    // mark it claimed so competing claims from other players lose, and
    // broadcast a 'g_pick' so every client removes the mesh + applies
    // the score/heal effect on the claimer.
    if (data.type === "pick" && seat?.kind === "human") {
      const gid = data.id | 0;
      const g = this.garbage.find(x => x.id === gid);
      if (!g || g.claimed) return;
      // Distance guard: make sure the claimer is within a sane radius
      // of the piece. Uses the seat's last-known pose (updated at
      // 20 Hz via the boat message).
      const dx = g.x - seat.x, dz = g.z - seat.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 20 * 20) return;  // more permissive than client OBB + magnet margin
      g.claimed = true;
      // Remove it from the active field.
      const idx2 = this.garbage.indexOf(g);
      if (idx2 !== -1) this.garbage.splice(idx2, 1);
      const seatIdx = this.state.seats.indexOf(seat);
      const pts = g.kind === 1 ? 1 : 1;
      seat.score += pts;
      if (g.kind === 1) seat.health = Math.min(seat.maxHealth, seat.health + 25);
      this.room.broadcast(JSON.stringify({
        type: "g_pick", id: g.id, by: seatIdx,
        k: g.kind, s: seat.score, h: seat.health,
      }));
      return;
    }

    // Sink notification: the sinking player's client tells us how
    // much plastic to scatter around the death point. We spawn them
    // as real shared garbage pieces so any captain (including the
    // sinker once they respawn) can scoop them. Also drops the
    // sinker's score by the same amount.
    if (data.type === "sink_drop" && seat?.kind === "human") {
      const pts = Math.max(0, Math.min(MAX_DEATH_DROP, Number(data.pts) || 0));
      if (pts === 0) return;
      // Clamp drop count + position jitter so we don't blow past the
      // garbage cap (extras beyond MAX_GARBAGE are silently skipped).
      const items: Array<{ id: number; x: number; z: number; k: 0 | 1 }> = [];
      for (let i = 0; i < pts && this.garbage.length < MAX_GARBAGE; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 6;
        const g: Garbage = {
          id: this.garbageNextId++,
          x: Math.round((seat.x + Math.cos(a) * r) * 100) / 100,
          z: Math.round((seat.z + Math.sin(a) * r) * 100) / 100,
          kind: 0,
          claimed: false,
        };
        this.garbage.push(g);
        items.push({ id: g.id, x: g.x, z: g.z, k: 0 });
      }
      if (items.length) {
        this.room.broadcast(JSON.stringify({ type: "g_add", items }));
      }
      seat.score = Math.max(0, seat.score - pts);
      return;
    }

    // Pirate hit: attacker client detected a fireball/ram landing on
    // a shared pirate. Validate distance + pirate alive, deduct HP,
    // broadcast echo. If HP <= 0, broadcast p_kill so every client
    // plays the explosion + removes the model.
    if (data.type === "p_hit") {
      const pid = data.id | 0;
      const dmg = Math.max(0, Math.min(500, Number(data.dmg) || 0));
      const p = this.pirates.find(x => x.id === pid);
      if (!p || !p.emerged) return;
      const attackerSeat = this.findSeatByConn(conn.id);
      if (!attackerSeat || attackerSeat.kind !== "human") return;
      // Distance guard — attacker can't hit a pirate across the map.
      const dx = p.x - attackerSeat.x, dz = p.z - attackerSeat.z;
      if (dx * dx + dz * dz > 100 * 100) return;
      p.health = Math.max(0, p.health - dmg);
      if (p.health <= 0) {
        this.pirates = this.pirates.filter(x => x.id !== pid);
        this.room.broadcast(JSON.stringify({
          type: "p_kill", id: pid, x: p.x, z: p.z,
          attacker: this.state.seats.indexOf(attackerSeat),
        }));
      } else {
        this.room.broadcast(JSON.stringify({ type: "p_dmg", id: pid, h: p.health, dmg }));
      }
      return;
    }

    // Mine detonate: a client drove onto a mine. Validate existence +
    // rough distance, then broadcast so every client plays the boom.
    if (data.type === "m_det") {
      const mid = data.id | 0;
      const idx = this.mines.findIndex(m => m.id === mid);
      if (idx === -1) return;
      const m = this.mines[idx];
      const attackerSeat = this.findSeatByConn(conn.id);
      if (attackerSeat && attackerSeat.kind === "human") {
        const dx = m.x - attackerSeat.x, dz = m.z - attackerSeat.z;
        if (dx * dx + dz * dz > 20 * 20) return;
      }
      this.mines.splice(idx, 1);
      this.room.broadcast(JSON.stringify({ type: "m_exp", id: mid, x: m.x, z: m.z }));
      return;
    }

    // Hit event: an attacker client detected a ram / fireball landing
    // on a remote-driven slot. We validate server-side (invuln window,
    // target alive, target is actually a human), deduct health, and
    // fan the event out so every client plays the hit vignette.
    if (data.type === "hit") {
      const targetIdx = data.target | 0;
      const dmg = Math.max(0, Math.min(100, Number(data.dmg) || 0));
      const source = String(data.source || "unknown").slice(0, 16);
      if (targetIdx < 0 || targetIdx >= this.state.seats.length) return;
      const target = this.state.seats[targetIdx];
      if (!target || target.kind !== "human") return;
      const attackerSeat = this.findSeatByConn(conn.id);
      // Don't let a client hit itself (sanity against bugs/cheats).
      if (attackerSeat && attackerSeat === target) return;
      const nowMs = Date.now();
      if (nowMs < target.invulnUntil) return;
      target.health = Math.max(0, target.health - dmg);
      target.invulnUntil = nowMs + HIT_INVULN_MS;
      const attackerIdx = attackerSeat && attackerSeat.kind === "human"
        ? this.state.seats.indexOf(attackerSeat)
        : -1;
      this.room.broadcast(JSON.stringify({
        type: "hit",
        target: targetIdx,
        attacker: attackerIdx,
        dmg,
        source,
        health: target.health,
      }));
      // If the victim is now sunk, broadcast a respawn notice so every
      // client plays the sink effect and resets health to max.
      if (target.health <= 0) {
        target.health = target.maxHealth;
        this.room.broadcast(JSON.stringify({
          type: "sink",
          target: targetIdx,
        }));
      }
      return;
    }

    if (data.type === "hello" && seat?.kind === "human") {
      const raw = String(data.name ?? "Capitaine").slice(0, 16).trim() || "Capitaine";
      seat.name = this.ensureUniqueName(raw, conn.id);
      this.broadcastState();
      return;
    }

    if (data.type === "ready" && seat?.kind === "human" && this.state.phase === "LOBBY") {
      seat.ready = !!data.value;
      // Arm the quick-start countdown only when every human is ready.
      // If someone un-readies, disarm it.
      if (allHumansReady(this.state)) {
        this.state.phaseEndsAt = Date.now() + QUICK_START_MS;
      } else {
        this.state.phaseEndsAt = 0;
      }
      this.broadcastState();
      return;
    }
  }

  onClose(conn: Party.Connection) {
    // Human drops → their seat flips back to a bot so the round stays
    // at 4 boats. Their score (once we add it in M4) will persist on the
    // bot until round end.
    const idx = this.state.seats.findIndex(
      (s) => s.kind === "human" && s.id === conn.id
    );
    if (idx !== -1) {
      // Humans-only mode: vacated seat goes back to empty, not bot.
      this.state.seats[idx] = { kind: "empty" };
      // If the drop breaks the all-ready condition, disarm the quick
      // start so the remaining players aren't catapulted out of lobby.
      if (this.state.phase === "LOBBY" && !allHumansReady(this.state)) {
        this.state.phaseEndsAt = 0;
      }
      this.broadcastState();
    }
    if (humanCount(this.state) === 0) {
      // No humans left: stop burning compute. A new connection will
      // restart the ticker via onConnect.
      this.stopTicker();
    }
  }

  // Drop human seats that haven't sent a message (heartbeat or otherwise)
  // for longer than GHOST_TIMEOUT_MS. Covers the case where a tab died
  // without sending a WS close frame — PartyKit may still list the
  // connection as alive, so we can't trust getConnections() alone.
  private reapGhostSeats(): boolean {
    const now = Date.now();
    let changed = false;
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind === "human" && now - s.lastSeenAt > GHOST_TIMEOUT_MS) {
        this.state.seats[i] = { kind: "empty" };
        changed = true;
      }
    }
    return changed;
  }

  // ---- state machine ----
  private tick() {
    const now = Date.now();
    // Clean up ghost seats first so the "all ready" check below is honest.
    if (this.reapGhostSeats()) {
      // If a ghost being reaped breaks the all-ready condition, disarm
      // the quick-start so the remaining solo player isn't catapulted
      // into a round with no real opponent.
      if (this.state.phase === "LOBBY" && !allHumansReady(this.state)) {
        this.state.phaseEndsAt = 0;
      }
      this.broadcastState();
    }
    // If every human has vanished, reset to a fresh lobby so the next
    // player to arrive doesn't inherit a stale COUNTDOWN/PLAYING/RECAP.
    if (humanCount(this.state) === 0 && this.state.phase !== "LOBBY") {
      this.state = initialState();
      this.broadcastState();
      this.stopTicker();
      return;
    }
    // LOBBY never auto-advances on a clock. The only trigger is "all
    // humans ready" (and there must be >= MIN_HUMANS_TO_START), which
    // arms phaseEndsAt to now + QUICK_START_MS in the ready handler.
    if (this.state.phase === "LOBBY") {
      if (this.state.phaseEndsAt === 0) return;
      if (now < this.state.phaseEndsAt) return;
    } else {
      if (now < this.state.phaseEndsAt) return;
    }
    switch (this.state.phase) {
      case "LOBBY":
        // By construction we only get here when phaseEndsAt was armed
        // by all-ready. Advance to the 3-2-1 countdown.
        this.state.phase = "COUNTDOWN";
        this.state.phaseEndsAt = now + COUNTDOWN_MS;
        break;
      case "COUNTDOWN":
        this.state.phase = "PLAYING";
        this.state.phaseEndsAt = now + PLAYING_MS;
        this.roundStartedAt = now;
        // Reset per-round state.
        for (const s of this.state.seats) {
          if (s.kind === "human") { s.score = 0; s.health = s.maxHealth; }
        }
        this.garbage.length = 0;
        this.ensureGarbageField();
        this.resetWorld();
        break;
      case "PLAYING":
        this.state.phase = "RECAP";
        this.state.phaseEndsAt = now + RECAP_MS;
        this.clearGarbageField();
        this.resetWorld();
        this.room.broadcast(JSON.stringify({ type: "w_reset" }));
        break;
      case "RECAP":
        // Fresh round: reset ready flags, freshen bot names, keep humans.
        const keptHumans = this.state.seats.map((s) => s.kind === "human" ? { ...s, ready: false } : s);
        this.state = initialState();
        for (let i = 0; i < 4; i++) {
          if (keptHumans[i] && keptHumans[i].kind === "human") this.state.seats[i] = keptHumans[i];
        }
        // Lobby waits for ready clicks again, no auto-timer.
        this.state.phaseEndsAt = 0;
        break;
    }
    this.broadcastState();
  }

  // During PLAYING, fan out a compact "poses" message with just the
  // per-seat x/z/rotation. Much smaller than the full state (which
  // carries name/ready/color/pid/etc) — this is what runs 20 Hz and
  // drives the remote-boat interpolation. Full state broadcasts are
  // reserved for actual state changes (phase, ready, hello, seat
  // takeover) to keep the wire quiet.
  // Track the last-broadcast seat pose so we can skip when nothing
  // moved and save bandwidth.
  private lastPoseHash = "";

  private broadcastIfPlaying() {
    if (this.state.phase !== "PLAYING") return;
    const poses: Array<any> = [];
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind === "human") {
        const p: any = {
          i,
          x: Math.round(s.x * 100) / 100,
          z: Math.round(s.z * 100) / 100,
          r: Math.round(s.rot * 1000) / 1000,
          h: s.health | 0, // 0..100
          s: s.score | 0,
        };
        if (s.boosting) p.b = 1;
        poses.push(p);
      }
    }
    // World poses: pirates + whale + hydro, slim shapes.
    const world: any = {};
    if (this.pirates.length) world.p = this.pirates.map(p => ({
      i: p.id,
      x: Math.round(p.x * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      r: Math.round(p.rot * 1000) / 1000,
      h: p.health | 0,
      e: p.emerged ? 1 : 0,
    }));
    if (this.whale) world.w = {
      x: Math.round(this.whale.x * 100) / 100,
      z: Math.round(this.whale.z * 100) / 100,
      r: Math.round(this.whale.rot * 1000) / 1000,
      s: this.whale.state,
    };
    if (this.hydro) world.h = {
      x: Math.round(this.hydro.x * 100) / 100,
      z: Math.round(this.hydro.z * 100) / 100,
      r: Math.round(this.hydro.rot * 1000) / 1000,
    };
    // Skip the send if nothing changed since last tick. Rough hash
    // is cheap and catches the common "everybody standing still"
    // case after respawn / lobby.
    const hashParts: string[] = [];
    for (const p of poses) hashParts.push(p.i + ':' + p.x + ',' + p.z + ',' + p.r + ',' + p.h + ',' + p.s + (p.b ? 'b' : ''));
    if (world.p) for (const p of world.p) hashParts.push('P' + p.i + ':' + p.x + ',' + p.z + ',' + p.r + ',' + p.h + ',' + p.e);
    if (world.w) hashParts.push('W' + world.w.x + ',' + world.w.z + ',' + world.w.s);
    if (world.h) hashParts.push('H' + world.h.x + ',' + world.h.z);
    const hash = hashParts.join('|');
    if (hash === this.lastPoseHash) return;
    this.lastPoseHash = hash;
    this.room.broadcast(JSON.stringify({ type: "poses", poses, world }));
  }

  // ---- helpers ----
  private findSeatByConn(id: string): Seat | undefined {
    return this.state.seats.find((s) => s.kind === "human" && s.id === id);
  }
  private ensureUniqueName(name: string, ownId: string): string {
    const taken = new Set(
      this.state.seats
        .filter((s) => s.kind === "human" && (s as any).id !== ownId)
        .map((s) => (s as any).name as string)
    );
    if (!taken.has(name)) return name;
    for (let n = 2; n < 99; n++) {
      const candidate = `${name}_${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return name;
  }
  private broadcastState() {
    this.room.broadcast(JSON.stringify({ type: "state", state: this.state }));
  }
}

TrashureRoom satisfies Party.Worker;
