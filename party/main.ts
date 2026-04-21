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
    }
  | { kind: "bot"; name: string; color: string };

// If we haven't heard from a human seat in this long, treat it as a
// ghost (browser crash, stuck connection, no close frame) and flip
// it back to a bot so the round state stays honest. Longer than the
// client's 3s ping cadence so backgrounded tabs (whose pings go via
// a Web Worker to escape throttling) survive a transient hiccup.
const GHOST_TIMEOUT_MS = 15_000;

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
const QUICK_START_MS   = 30_000; // 30s grace after all humans ready
const COUNTDOWN_MS     = 3_000;
const PLAYING_MS       = 180_000; // 3 minutes
const RECAP_MS         = 15_000;
const TICK_MS          = 50;      // 20 Hz. Full state on changes only; poses compact.
const MIN_HUMANS_TO_START = 2;    // solo lobby never advances: use "Play offline" on the client
const MAX_HEALTH_SERVER   = 100;  // match client MAX_HEALTH
const HIT_INVULN_MS       = 700;  // match client INVULN_AFTER_HIT (0.7s)

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

  constructor(readonly room: Party.Room) {
    this.state = initialState();
  }

  private startTicker() {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.tick();
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
    this.state.seats[idx] = { kind: "human", id: conn.id, pid, name: "Capitaine", ready: false, color, lastSeenAt: Date.now(), x: 0, z: 0, rot: 0, boosting: false, health: MAX_HEALTH_SERVER, maxHealth: MAX_HEALTH_SERVER, invulnUntil: 0 };
    this.startTicker();
    this.broadcastState();
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

    if (data.type === "boat" && seat?.kind === "human") {
      const x = Number(data.x), z = Number(data.z), r = Number(data.rot);
      if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(r)) {
        seat.x = x; seat.z = z; seat.rot = r;
      }
      seat.boosting = !!data.b;
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
        break;
      case "PLAYING":
        this.state.phase = "RECAP";
        this.state.phaseEndsAt = now + RECAP_MS;
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
        };
        if (s.boosting) p.b = 1;
        poses.push(p);
      }
    }
    this.room.broadcast(JSON.stringify({ type: "poses", poses }));
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
