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

// Always-on world: there is a single PLAYING phase. Each player has a
// personal 3-min session timer that starts on connect / rejoin. No
// lobby, no countdown, no global recap.
type Phase = "PLAYING";

type Seat =
  | { kind: "empty" }
  | {
      kind: "human";
      id: string;
      pid: string;
      name: string;
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
      // Cumulative pickup count for the player's *current* session.
      // Frozen when sessionEndedAt is set; reset on rejoin.
      score: number;
      // --- Personal session timer (always-on world) ---
      // Epoch ms when the player's current 3-min session started. Each
      // player has their own independent session; there is no global
      // round. Refreshed on connect and on rejoin.
      sessionStartedAt: number;
      // Null while the session is in progress; set to epoch ms when
      // the 3-min timer expires. While non-null, the player becomes a
      // spectator, their score is frozen, and they can click Rejoin
      // to start a fresh session.
      sessionEndedAt: number | null;
      // The entry id this seat's *current alive* session belongs to,
      // or -1 if the player is between sessions. Used to attach score
      // updates to the correct historical entry. See `entries` below.
      currentEntryId: number;
    }
  | { kind: "bot"; name: string; color: string };

// If we haven't heard from a human seat in this long, treat it as a
// ghost (browser crash, stuck connection, no close frame) and flip
// it back to a bot so the round state stays honest. Longer than the
// client's 3s ping cadence so backgrounded tabs (whose pings go via
// a Web Worker to escape throttling) survive a transient hiccup.
const GHOST_TIMEOUT_MS = 15_000;

// Always-on AI captain. Lives on the server, wanders the ocean, picks
// up plastic just like a real player, gets a SessionEntry row, and
// respawns with a fresh entry every 3 min. Keeps the ocean feeling
// lived-in even when no humans are connected and guarantees at least
// a couple of rivals on the leaderboard.
type Bot = {
  botId: string;               // unique wire id, e.g. "npc_0"
  name: string;
  color: string;
  x: number;
  z: number;
  rot: number;
  targetX: number;             // current wander destination
  targetZ: number;
  targetGarbageId: number | null;
  pickCooldownAt: number;      // epoch ms — throttles rapid re-picks
  sessionStartedAt: number;
  sessionEndedAt: number | null;
  currentEntryId: number;
  score: number;
};

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

// A historical session entry on the leaderboard. One per session
// attempt. When a player finishes their 3-min session, their entry is
// frozen (sessionEndedAt set, alive=false). When they click Rejoin, a
// NEW entry is created — a single player can have many entries.
// Each viewer only sees entries whose session window overlapped with
// their own current session (the "cohort" model).
type SessionEntry = {
  entryId: number;
  seatIdx: number;              // -1 once the owning seat is gone
  pid: string;                  // stable player id (from WS query param)
  name: string;
  color: string;
  sessionStartedAt: number;     // epoch ms
  sessionEndedAt: number | null; // null while alive, set when 3 min expires
  score: number;                 // live while alive, frozen on end
};

interface RoomState {
  phase: Phase;
  // Epoch ms when the current phase ends. Always 0 in this build —
  // there is no global round clock; each player has a personal timer.
  phaseEndsAt: number;
  // Dynamic seat list. Grows up to MAX_SEATS as players join; seats
  // flip back to "empty" on disconnect but the slot itself is reused
  // so seat indices stay stable for existing players.
  seats: Seat[];
}

// Personal session duration — each player gets their own 3-min run.
const SESSION_MS       = 180_000; // 3 minutes per player
const TICK_MS          = 100;     // 10 Hz. Halved from 20 Hz to keep bandwidth low — client-side snapshot interpolation fills the gap smoothly.
const MAX_SEATS           = 50;   // target concurrent player cap — expand as needed
const MAX_HEALTH_SERVER   = 100;  // match client MAX_HEALTH
const HIT_INVULN_MS       = 700;  // match client INVULN_AFTER_HIT (0.7s)

// --- AI captains ---
const BOT_COUNT           = 2;     // always-on AI bots, independent of humans
const BOT_NAMES           = ["Coral", "Marlin"];
const BOT_COLORS          = ["#4ade80", "#a78bfa"];
const BOT_SPEED           = 9;     // world-units / s — slightly slower than humans
const BOT_PICKUP_RADIUS   = 2.2;   // bot needs to get close enough to claim a piece
const BOT_PICKUP_COOLDOWN_MS = 180; // anti-spam cap
const BOT_RETARGET_CHANCE = 0.01;  // per-tick chance to pick a new wander point
const BOT_TARGET_RETIRE_MS = 6000; // if bot can't reach target in 6s, give up

// Shared garbage field. Keep the counts modest so the per-tick wire
// + initial snapshot stay cheap.
const MAX_GARBAGE          = 50;   // enough to keep the ocean stocked for 2+ players
const GARBAGE_WORLD_RADIUS = 155;  // slightly inside the client WORLD_RADIUS (160)
const GARBAGE_ISLAND_PAD   = 18;
const GARBAGE_SPAWN_MS     = 700;  // ~1.4 Hz — faster restock
const PINK_CHANCE          = 0.10; // fraction of spawns that heal
const MAX_DEATH_DROP       = 6;    // cap per-sink drop so a chain of deaths doesn't flood

// World entities
// Always-on world: one pirate ship is always present. After a sink,
// a new one respawns after PIRATE_RESPAWN_MS — the threat never goes
// away, but never escalates into a "wave" either.
const PIRATE_FIRST_SPAWN_MS = 0;        // spawn immediately when the room boots
const PIRATE_MAX            = 1;        // single boat at a time
const PIRATE_RESPAWN_MS     = 10_000;   // 10s dormant window after a kill
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

// Palette rotates by seat index so boats stay visually distinct even
// when the room is near full. Seven distinct hues; beyond that the
// palette simply cycles.
const COLORS    = ["#ff5a3c", "#ffd93d", "#4ade80", "#22d3ee", "#a78bfa", "#f472b6", "#60a5fa"];

function initialState(): RoomState {
  return {
    phase: "PLAYING",
    // No global phase clock — personal timers live on the seats.
    phaseEndsAt: 0,
    // Seats grow dynamically as players arrive (up to MAX_SEATS).
    seats: [],
  };
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

  // World — always alive in this build. Entities are created when the
  // first player connects and persist until the room shuts down.
  private pirates: Pirate[] = [];
  private pirateNextId = 1;
  // When > 0: we destroyed the pirate at this epoch ms + RESPAWN_MS
  // and we should spawn a fresh one once the cooldown elapses. 0 means
  // "no respawn pending" (either a pirate is alive or we're booting).
  private pirateRespawnAt = 0;
  private mines: Mine[] = [];
  private mineNextId = 1;
  private bombs: Bomb[] = [];
  private bombNextId = 1;
  private whale: Whale | null = null;
  private hydro: Hydro | null = null;
  // Epoch ms when the oldest currently-connected player's session
  // began — used as the "world start" reference for staggered events
  // like the whale / hydronaute first-spawn delays.
  private worldStartedAt = 0;

  // --- Session history ---
  // One entry per session attempt. Frozen entries persist for viewers
  // whose session window overlapped with the entry. See SessionEntry
  // for the cohort filtering rule.
  private entries: SessionEntry[] = [];
  private entryNextId = 1;

  // --- AI bot captains ---
  // Always-on NPC boats. Created once per room lifetime; their
  // `sessionStartedAt` cycles every 3 min (old SessionEntry freezes,
  // new one created — just like humans hitting Rejoin).
  private bots: Bot[] = [];

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
  // Only called when the room empties out (no humans left) to free
  // memory. In the always-on build we otherwise leave world entities
  // alive between players so the ocean feels continuous.
  private resetWorld() {
    this.pirates = [];
    this.mines = [];
    this.bombs = [];
    this.whale = null;
    this.hydro = null;
    this.pirateNextId = 1;
    this.mineNextId = 1;
    this.bombNextId = 1;
    this.pirateRespawnAt = 0;
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
    // Always-on world — no phase gate. We only sleep the ticker
    // entirely when humanCount() drops to 0 (handled in startTicker).
    const now = Date.now();
    const elapsed = now - this.worldStartedAt;
    const dt = dtMs / 1000;

    // Pirate lifecycle: exactly PIRATE_MAX (1) pirate alive at a time.
    // When one is destroyed, `pirateRespawnAt` is armed to now + 10s
    // by the p_hit kill branch. We spawn a replacement when the cooldown
    // elapses. No progressive ramp; the threat is constant, never escalates.
    if (this.pirates.length < PIRATE_MAX) {
      const shouldSpawn =
        // First spawn when the world boots (first human arrives).
        (this.pirateRespawnAt === 0 && elapsed >= PIRATE_FIRST_SPAWN_MS) ||
        // Subsequent respawns after the 10s cooldown.
        (this.pirateRespawnAt > 0 && now >= this.pirateRespawnAt);
      if (shouldSpawn) {
        const p = this.spawnPirate();
        this.pirates.push(p);
        this.pirateRespawnAt = 0;
        this.room.broadcast(JSON.stringify({ type: "p_add", p: this.pirateWire(p) }));
      }
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
    this.ensureBots();
    this.tickTimer = setInterval(() => {
      this.tick();
      this.tickGarbage(TICK_MS);
      this.tickWorld(TICK_MS);
      this.tickBots(TICK_MS);
      this.broadcastIfPlaying();
    }, TICK_MS);
  }
  private stopTicker() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // Freeze + drop the AI bots so a fresh room starts clean. Their
    // entries get pruned naturally once no witness is left.
    for (const b of this.bots) {
      if (b.sessionEndedAt === null) this.endEntry(b.currentEntryId, Date.now());
    }
    this.bots.length = 0;
  }

  // --- SESSION ENTRIES ---
  // Create a fresh entry for a new or rejoining player. Returns the
  // new entry; broadcasting the add is handled by the caller (or by
  // a full entries snapshot on first connect).
  private createEntry(
    seatIdx: number,
    pid: string,
    name: string,
    color: string,
    now: number,
  ): SessionEntry {
    const e: SessionEntry = {
      entryId: this.entryNextId++,
      seatIdx,
      pid,
      name,
      color,
      sessionStartedAt: now,
      sessionEndedAt: null,
      score: 0,
    };
    this.entries.push(e);
    // Broadcast the newborn entry so every connected client whose
    // session window now overlaps with this one can show it.
    this.broadcastEntryAdd(e);
    return e;
  }

  // Freeze a session entry. Called when a player's 3-min timer
  // expires, when they disconnect mid-session, or during ghost reap.
  private endEntry(entryId: number, now: number) {
    const e = this.entries.find(x => x.entryId === entryId);
    if (!e || e.sessionEndedAt !== null) return;
    e.sessionEndedAt = now;
    this.room.broadcast(JSON.stringify({
      type: "e_end", id: e.entryId, at: now, score: e.score,
    }));
  }

  // Returns the entries visible to a given viewer (seat idx), applying
  // the cohort filter: an entry is visible if it's still alive OR it
  // ended after the viewer's current session started. Self is always
  // visible. Returns wire-format payloads.
  private entriesForViewer(viewerSeatIdx: number): any[] {
    const seat = this.state.seats[viewerSeatIdx];
    // No viewer-seat context → show everything alive (used for pure
    // spectators over the MAX_SEATS cap).
    const viewerSince = (seat && seat.kind === "human") ? seat.sessionStartedAt : 0;
    const out: any[] = [];
    for (const e of this.entries) {
      const alive = e.sessionEndedAt === null;
      const overlapped = !alive && (e.sessionEndedAt as number) >= viewerSince;
      const isSelf = seat && seat.kind === "human" && e.entryId === seat.currentEntryId;
      if (alive || overlapped || isSelf) {
        out.push(this.entryWire(e));
      }
    }
    return out;
  }

  private entryWire(e: SessionEntry) {
    return {
      id: e.entryId,
      seat: e.seatIdx,
      name: e.name,
      color: e.color,
      startedAt: e.sessionStartedAt,
      endedAt: e.sessionEndedAt,
      score: e.score,
    };
  }

  // Broadcast a freshly-added entry to all viewers whose cohort
  // includes it (trivially: everyone alive now).
  private broadcastEntryAdd(e: SessionEntry) {
    this.room.broadcast(JSON.stringify({ type: "e_add", e: this.entryWire(e) }));
  }

  // Send the full cohort-filtered entries list to one connection.
  // Used on connect / reconnect so the joining client starts with a
  // consistent leaderboard.
  private sendEntriesSnapshot(conn: Party.Connection) {
    const seat = this.findSeatByConn(conn.id);
    const seatIdx = seat ? this.state.seats.indexOf(seat) : -1;
    const entries = this.entriesForViewer(seatIdx);
    try { conn.send(JSON.stringify({ type: "e_snap", entries })); } catch {}
  }

  // Prune entries that no currently-connected viewer can see anymore.
  // Safe to call periodically; keeps memory from growing unbounded.
  private pruneEntries() {
    if (this.entries.length === 0) return;
    // Minimum "sessionStartedAt" among connected alive players — any
    // finished entry that ended before this cutoff is invisible to
    // everyone and can be dropped.
    let cutoff = Infinity;
    for (const s of this.state.seats) {
      if (s.kind === "human" && s.sessionEndedAt === null) {
        if (s.sessionStartedAt < cutoff) cutoff = s.sessionStartedAt;
      }
    }
    if (cutoff === Infinity) {
      // No active sessions — keep entries for now (they'll still be
      // visible to the next joiner if they're alive). If there are no
      // alive entries either, safe to drop everything.
      const anyAlive = this.entries.some(e => e.sessionEndedAt === null);
      if (!anyAlive) this.entries = [];
      return;
    }
    this.entries = this.entries.filter(e =>
      e.sessionEndedAt === null || (e.sessionEndedAt as number) >= cutoff
    );
  }

  // --- BOTS ---
  // Create the two always-on AI captains if they don't exist yet.
  // Called from startTicker() so they come alive as soon as the first
  // human arrives (and vanish with the ticker when everyone leaves).
  private ensureBots() {
    if (this.bots.length >= BOT_COUNT) return;
    const now = Date.now();
    for (let i = this.bots.length; i < BOT_COUNT; i++) {
      const botId = "npc_" + i;
      const name  = BOT_NAMES[i % BOT_NAMES.length];
      const color = BOT_COLORS[i % BOT_COLORS.length];
      const spawn = this.pickBotSpawn();
      const entry = this.createBotEntry(botId, name, color, now);
      this.bots.push({
        botId, name, color,
        x: spawn.x, z: spawn.z,
        rot: Math.random() * Math.PI * 2,
        targetX: spawn.x, targetZ: spawn.z,
        targetGarbageId: null,
        pickCooldownAt: 0,
        sessionStartedAt: now,
        sessionEndedAt: null,
        currentEntryId: entry.entryId,
        score: 0,
      });
    }
  }

  private pickBotSpawn() {
    const a = Math.random() * Math.PI * 2;
    const r = GARBAGE_ISLAND_PAD + 10 + Math.random() * 40;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  // Entries for bots use a synthetic pid + seatIdx=-1 so they sit on
  // the leaderboard alongside humans without occupying a real seat.
  private createBotEntry(botId: string, name: string, color: string, now: number): SessionEntry {
    const e: SessionEntry = {
      entryId: this.entryNextId++,
      seatIdx: -1,
      pid: "bot:" + botId,
      name, color,
      sessionStartedAt: now,
      sessionEndedAt: null,
      score: 0,
    };
    this.entries.push(e);
    this.broadcastEntryAdd(e);
    return e;
  }

  // Per-tick AI: steer toward a wander point (or the nearest piece of
  // plastic if one is in range), auto-pick any garbage we bump into,
  // and cycle the SessionEntry every SESSION_MS.
  private tickBots(dtMs: number) {
    if (this.bots.length === 0) return;
    const now = Date.now();
    const dt = dtMs / 1000;
    for (const b of this.bots) {
      // Session lifecycle — same 3-min rhythm as humans.
      if (now >= b.sessionStartedAt + SESSION_MS) {
        this.endEntry(b.currentEntryId, now);
        const entry = this.createBotEntry(b.botId, b.name, b.color, now);
        b.sessionStartedAt = now;
        b.currentEntryId = entry.entryId;
        b.score = 0;
        const spawn = this.pickBotSpawn();
        b.x = spawn.x; b.z = spawn.z;
        b.targetGarbageId = null;
      }

      // Target acquisition — nearest unclaimed piece within ~50 units,
      // or wander to a random point.
      if (b.targetGarbageId !== null) {
        const g = this.garbage.find(x => x.id === b.targetGarbageId);
        if (!g || g.claimed) b.targetGarbageId = null;
      }
      if (b.targetGarbageId === null && Math.random() < 0.5) {
        let bestId = -1, bestD2 = 50 * 50;
        for (const g of this.garbage) {
          if (g.claimed) continue;
          const dx = g.x - b.x, dz = g.z - b.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; bestId = g.id; }
        }
        if (bestId !== -1) b.targetGarbageId = bestId;
      }
      if (b.targetGarbageId !== null) {
        const g = this.garbage.find(x => x.id === b.targetGarbageId);
        if (g) { b.targetX = g.x; b.targetZ = g.z; }
      } else {
        // Wander: pick a new destination occasionally or once we've
        // roughly reached the current one.
        const dxW = b.targetX - b.x, dzW = b.targetZ - b.z;
        if (dxW * dxW + dzW * dzW < 4 || Math.random() < BOT_RETARGET_CHANCE) {
          const w = this.pickBotSpawn();
          b.targetX = w.x; b.targetZ = w.z;
        }
      }

      // Steering: turn toward target, move forward.
      const dx = b.targetX - b.x, dz = b.targetZ - b.z;
      const wantA = Math.atan2(dx, dz);
      let diff = wantA - b.rot;
      while (diff >  Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      b.rot += Math.max(-1, Math.min(1, diff)) * dt * 2.0;
      b.x += Math.sin(b.rot) * BOT_SPEED * dt;
      b.z += Math.cos(b.rot) * BOT_SPEED * dt;

      // Clamp inside the world ring.
      const d = Math.hypot(b.x, b.z);
      if (d > GARBAGE_WORLD_RADIUS) {
        b.x = (b.x / d) * GARBAGE_WORLD_RADIUS;
        b.z = (b.z / d) * GARBAGE_WORLD_RADIUS;
      }
      if (d < GARBAGE_ISLAND_PAD) {
        const a = Math.atan2(b.z, b.x) || 0;
        b.x = Math.cos(a) * (GARBAGE_ISLAND_PAD + 1);
        b.z = Math.sin(a) * (GARBAGE_ISLAND_PAD + 1);
      }

      // Pickup: auto-claim any piece within BOT_PICKUP_RADIUS.
      if (now >= b.pickCooldownAt) {
        for (const g of this.garbage) {
          if (g.claimed) continue;
          const gdx = g.x - b.x, gdz = g.z - b.z;
          if (gdx * gdx + gdz * gdz <= BOT_PICKUP_RADIUS * BOT_PICKUP_RADIUS) {
            g.claimed = true;
            const idx = this.garbage.indexOf(g);
            if (idx !== -1) this.garbage.splice(idx, 1);
            const pts = ((g as any).points | 0) || 1;
            b.score += pts;
            const entry = this.entries.find(e => e.entryId === b.currentEntryId);
            if (entry) entry.score = b.score;
            // Broadcast the pick so every client removes the mesh +
            // plays the +N floater. `by` is -1 to mean "not a seat";
            // `bot` carries the bot id so the client can route the
            // score update (and eid so the leaderboard row ticks).
            this.room.broadcast(JSON.stringify({
              type: "g_pick", id: g.id, by: -1, bot: b.botId,
              k: g.kind, s: b.score, p: pts,
              eid: b.currentEntryId,
            }));
            b.pickCooldownAt = now + BOT_PICKUP_COOLDOWN_MS;
            if (b.targetGarbageId === g.id) b.targetGarbageId = null;
            break;
          }
        }
      }
    }
  }

  // ---- lifecycle ----
  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // Client sends a persistent id in the WS URL query. On reconnect
    // (e.g. short network drop), we match on pid and re-seat the same
    // player — we keep their active session (timer, score, entry)
    // rather than starting over.
    let pid = "";
    try { pid = new URL(ctx.request.url).searchParams.get("pid") || ""; } catch {}

    if (pid) {
      const existingIdx = this.state.seats.findIndex(
        (s) => s.kind === "human" && (s as any).pid === pid
      );
      if (existingIdx !== -1) {
        const seat = this.state.seats[existingIdx] as Extract<Seat, { kind: "human" }>;
        seat.id = conn.id;
        seat.lastSeenAt = Date.now();
        // keep last known x/z/rot so the boat doesn't teleport on brief drops
        this.startTicker();
        // Re-sync the world so the reconnecting client redraws it.
        this.sendGarbageSnapshot(conn);
        this.sendWorldSnapshot(conn);
        this.sendEntriesSnapshot(conn);
        this.broadcastState();
        return;
      }
    }

    // Opportunistic cleanup: flush any ghost seats whose last activity
    // is older than GHOST_TIMEOUT_MS before we seat the new player.
    this.reapGhostSeats();

    // Find an empty slot (reuses disconnected seats) or append a new
    // one up to MAX_SEATS. Past the cap the player is a pure spectator.
    let idx = this.state.seats.findIndex((s) => s.kind === "empty");
    if (idx === -1) {
      if (this.state.seats.length < MAX_SEATS) {
        idx = this.state.seats.length;
        this.state.seats.push({ kind: "empty" });
      } else {
        conn.send(JSON.stringify({ type: "spectator" }));
        conn.send(JSON.stringify({ type: "state", state: this.state }));
        this.sendEntriesSnapshot(conn);
        return;
      }
    }
    // Color cycles through the palette so distant boats stay visually distinct.
    const color = COLORS[idx % COLORS.length];
    const now = Date.now();
    // Create a fresh session entry for this new connection.
    const entry = this.createEntry(idx, pid, "Capitaine", color, now);
    this.state.seats[idx] = {
      kind: "human",
      id: conn.id,
      pid,
      name: "Capitaine",
      color,
      lastSeenAt: now,
      x: 0, z: 0, rot: 0,
      boosting: false,
      health: MAX_HEALTH_SERVER,
      maxHealth: MAX_HEALTH_SERVER,
      invulnUntil: 0,
      score: 0,
      sessionStartedAt: now,
      sessionEndedAt: null,
      currentEntryId: entry.entryId,
    };
    // First human primes the world clock.
    if (this.worldStartedAt === 0) this.worldStartedAt = now;
    this.startTicker();
    this.broadcastState();
    // Always sync world + garbage + entry history for a fresh player.
    this.sendGarbageSnapshot(conn);
    this.sendWorldSnapshot(conn);
    this.sendEntriesSnapshot(conn);
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
      // Finished players become spectators: their score is frozen
      // and they can't pick up plastic until they rejoin.
      if (seat.sessionEndedAt !== null) return;
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
      // Death-drop pieces carry a points value (5); normal pieces = 1.
      const pts = ((g as any).points | 0) || 1;
      seat.score += pts;
      // Mirror onto the current session entry so the leaderboard ticks.
      const entry = this.entries.find(e => e.entryId === seat.currentEntryId);
      if (entry) entry.score = seat.score;
      if (g.kind === 1) seat.health = Math.min(seat.maxHealth, seat.health + 25);
      this.room.broadcast(JSON.stringify({
        type: "g_pick", id: g.id, by: seatIdx,
        k: g.kind, s: seat.score, h: seat.health, p: pts,
        // Entry id so clients can update the correct leaderboard row
        // when multiple entries share the same seat/name.
        eid: seat.currentEntryId,
      }));
      return;
    }

    // Sink notification: the sinking player's client tells us how
    // much plastic to scatter around the death point. We spawn them
    // as real shared garbage pieces so any captain (including the
    // sinker once they respawn) can scoop them. Also drops the
    // sinker's score by the same amount.
    if (data.type === "sink_drop" && seat?.kind === "human") {
      // Session-ended spectators don't drop anything when they sink —
      // they already stopped scoring when their timer ran out.
      if (seat.sessionEndedAt !== null) return;
      // Drop ~25% of the sinker's score as normal-looking plastic
      // pieces with mixed point values (1, 2, or 3) so the total sums
      // close to the target. Capped by MAX_DEATH_DROP piece count so
      // a chain of deaths doesn't flood the ocean.
      const score = Math.max(0, Math.min(9999, Number(data.score) || 0));
      let wantPts = Math.floor(score * 0.25);
      if (wantPts <= 0) return;
      const items: Array<{ id: number; x: number; z: number; k: 0 | 1; p?: number }> = [];
      while (wantPts > 0 && items.length < MAX_DEATH_DROP && this.garbage.length < MAX_GARBAGE) {
        // Prefer bigger chunks while there's lots of plastic left to
        // distribute, taper down to 1-pt pieces at the tail.
        let pts: number;
        if (wantPts >= 3 && Math.random() < 0.5)      pts = 3;
        else if (wantPts >= 2 && Math.random() < 0.5) pts = 2;
        else                                           pts = 1;
        const a = Math.random() * Math.PI * 2;
        const r = 2 + Math.random() * 6;
        const g: any = {
          id: this.garbageNextId++,
          x: Math.round((seat.x + Math.cos(a) * r) * 100) / 100,
          z: Math.round((seat.z + Math.sin(a) * r) * 100) / 100,
          kind: 0,
          claimed: false,
          points: pts,
        };
        this.garbage.push(g);
        items.push({ id: g.id, x: g.x, z: g.z, k: 0, p: pts });
        wantPts -= pts;
      }
      if (items.length) {
        this.room.broadcast(JSON.stringify({ type: "g_add", items }));
      }
      const dropped = items.reduce((s, it) => s + (it.p || 1), 0);
      seat.score = Math.max(0, seat.score - dropped);
      // Keep the live entry in sync so the leaderboard reflects the loss.
      const dropEntry = this.entries.find(e => e.entryId === seat.currentEntryId);
      if (dropEntry) dropEntry.score = seat.score;
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
        // Arm the respawn cooldown. tickWorld will spawn a fresh
        // pirate after PIRATE_RESPAWN_MS has elapsed — always-on
        // world means there is always exactly one (modulo cooldown).
        this.pirateRespawnAt = Date.now() + PIRATE_RESPAWN_MS;
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
      // Propagate the name onto the live session entry so the
      // leaderboard shows the captain's chosen handle, not the default.
      const e = this.entries.find(x => x.entryId === seat.currentEntryId);
      if (e) {
        e.name = seat.name;
        this.room.broadcast(JSON.stringify({ type: "e_upd", id: e.entryId, name: e.name }));
      }
      this.broadcastState();
      return;
    }

    // Rejoin: a finished player wants another 3-min run. Create a new
    // session entry, reset score/health, start a fresh timer. The
    // previous entry stays frozen and visible to witnesses.
    if (data.type === "rejoin" && seat?.kind === "human") {
      if (seat.sessionEndedAt === null) return; // already alive, ignore
      const now = Date.now();
      seat.sessionStartedAt = now;
      seat.sessionEndedAt = null;
      seat.score = 0;
      seat.health = seat.maxHealth;
      seat.invulnUntil = 0;
      const entry = this.createEntry(
        this.state.seats.indexOf(seat),
        seat.pid,
        seat.name,
        seat.color,
        now,
      );
      seat.currentEntryId = entry.entryId;
      // Tell the rejoining client directly so it can restart its UI.
      try { conn.send(JSON.stringify({ type: "rejoined", entryId: entry.entryId, sessionStartedAt: now, sessionMs: SESSION_MS })); } catch {}
      this.broadcastState();
      return;
    }
  }

  onClose(conn: Party.Connection) {
    const idx = this.state.seats.findIndex(
      (s) => s.kind === "human" && s.id === conn.id
    );
    if (idx !== -1) {
      const seat = this.state.seats[idx] as Extract<Seat, { kind: "human" }>;
      // If they were mid-session, freeze their entry at its current
      // score. Witnesses who were playing alongside will still see
      // it on their leaderboards until they too finish or leave.
      if (seat.sessionEndedAt === null) {
        this.endEntry(seat.currentEntryId, Date.now());
      }
      this.state.seats[idx] = { kind: "empty" };
      this.broadcastState();
    }
    // Drop entries no one can see anymore.
    this.pruneEntries();
    if (humanCount(this.state) === 0) {
      // No humans left: stop burning compute + reset the world so the
      // next arrival starts with a clean slate. A new connection will
      // restart the ticker via onConnect.
      this.stopTicker();
      this.resetWorld();
      this.worldStartedAt = 0;
      // Entries live only as long as someone can see them; safe to
      // drop the frozen ones here too.
      this.pruneEntries();
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
  // Always-on world. The tick is responsible for:
  //   1. reaping ghost seats (stale connections)
  //   2. expiring per-seat 3-min sessions (freeze entry, notify client)
  //   3. shutting down the ticker + world when the room empties
  private tick() {
    const now = Date.now();
    let stateChanged = false;

    if (this.reapGhostSeats()) stateChanged = true;

    // Expire any sessions whose 3-min timer has run out. We freeze the
    // entry and send a private "session_end" to that connection so the
    // client can show the "Your session: X — Rejoin" overlay.
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind !== "human") continue;
      if (s.sessionEndedAt !== null) continue;
      if (now >= s.sessionStartedAt + SESSION_MS) {
        s.sessionEndedAt = now;
        // Freeze the historical entry + broadcast the end to every
        // client so their leaderboards can FIN-badge this row.
        this.endEntry(s.currentEntryId, now);
        // Tell the owning connection privately so only they see the
        // "your session ended, rejoin?" overlay.
        const conn = [...this.room.getConnections()].find(c => c.id === s.id);
        if (conn) {
          try { conn.send(JSON.stringify({ type: "session_end", score: s.score, entryId: s.currentEntryId })); } catch {}
        }
        stateChanged = true;
      }
    }

    // If every human has vanished, reset everything so the next
    // arrival gets a clean slate.
    if (humanCount(this.state) === 0) {
      if (this.state.seats.length > 0) {
        this.state = initialState();
        this.stopTicker();
        this.resetWorld();
        this.worldStartedAt = 0;
        this.entries = [];
        this.broadcastState();
      }
      return;
    }

    if (stateChanged) this.broadcastState();
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
    // Always-on: no phase guard. We still skip when everyone is idle
    // via the pose hash below.
    const poses: Array<any> = [];
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind === "human") {
        // Skip broadcasting boat poses for players whose session
        // ended — they become spectators on other clients and their
        // boat mesh is hidden.
        if (s.sessionEndedAt !== null) continue;
        const p: any = {
          i,
          x: Math.round(s.x * 100) / 100,
          z: Math.round(s.z * 100) / 100,
          r: Math.round(s.rot * 1000) / 1000,
          h: s.health | 0, // 0..100
          s: s.score | 0,
          // Entry id attached so the client can route the live score
          // update to the correct leaderboard row even when the same
          // name has multiple frozen entries sitting next to a new one.
          eid: s.currentEntryId,
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
    // AI bots ride in their own bucket so clients can key them off the
    // stable botId string instead of fighting seat indices.
    const botPoses = this.bots.map(b => ({
      i: b.botId,
      x: Math.round(b.x * 100) / 100,
      z: Math.round(b.z * 100) / 100,
      r: Math.round(b.rot * 1000) / 1000,
      s: b.score | 0,
      eid: b.currentEntryId,
    }));
    // Skip the send if nothing changed since last tick. Rough hash
    // is cheap and catches the common "everybody standing still"
    // case after respawn / lobby.
    const hashParts: string[] = [];
    for (const p of poses) hashParts.push(p.i + ':' + p.x + ',' + p.z + ',' + p.r + ',' + p.h + ',' + p.s + (p.b ? 'b' : ''));
    if (world.p) for (const p of world.p) hashParts.push('P' + p.i + ':' + p.x + ',' + p.z + ',' + p.r + ',' + p.h + ',' + p.e);
    if (world.w) hashParts.push('W' + world.w.x + ',' + world.w.z + ',' + world.w.s);
    if (world.h) hashParts.push('H' + world.h.x + ',' + world.h.z);
    for (const b of botPoses) hashParts.push('B' + b.i + ':' + b.x + ',' + b.z + ',' + b.r + ',' + b.s);
    const hash = hashParts.join('|');
    if (hash === this.lastPoseHash) return;
    this.lastPoseHash = hash;
    this.room.broadcast(JSON.stringify({ type: "poses", poses, world, bots: botPoses }));
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
