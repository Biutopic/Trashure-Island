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
  | { kind: "human"; id: string; pid: string; name: string; ready: boolean; color: string }
  | { kind: "bot"; name: string; color: string };

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
const QUICK_START_MS   = 1_500;
const COUNTDOWN_MS     = 3_000;
const PLAYING_MS       = 180_000; // 3 minutes
const RECAP_MS         = 15_000;
const TICK_MS          = 250;     // state-machine tick cadence
const MIN_HUMANS_TO_START = 2;    // solo lobby never advances: use "Play offline" on the client

const BOT_NAMES = ["Coral", "Marlin", "Triton", "Dory", "Splash", "Reef"];
const COLORS    = ["#ff5a3c", "#ffd93d", "#4ade80", "#22d3ee", "#c084fc", "#fb7185"];

function makeBotSeats(): Seat[] {
  const picks = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 4);
  return picks.map((name, i) => ({ kind: "bot", name, color: COLORS[i % COLORS.length] } as Seat));
}

function initialState(): RoomState {
  return {
    phase: "LOBBY",
    // 0 = no countdown armed. Server arms it only when all humans are ready.
    phaseEndsAt: 0,
    seats: makeBotSeats(),
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
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
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
        this.startTicker();
        this.broadcastState();
        return;
      }
    }

    // Mid-round joining is allowed: the player takes over a bot seat
    // and inherits whatever the bot had (position, score — once those
    // move server-side in a later milestone). True spectator is only
    // used when all 4 seats are already human.
    const idx = this.state.seats.findIndex((s) => s.kind === "bot" || s.kind === "empty");
    if (idx === -1) {
      conn.send(JSON.stringify({ type: "spectator" }));
      conn.send(JSON.stringify({ type: "state", state: this.state }));
      return;
    }
    const prev = this.state.seats[idx];
    // If we're taking over a bot, keep its color so the leaderboard
    // layout doesn't shuffle mid-round.
    const color = prev.kind === "bot" ? prev.color : COLORS[idx % COLORS.length];
    this.state.seats[idx] = { kind: "human", id: conn.id, pid, name: "Capitaine", ready: false, color };
    this.startTicker();
    this.broadcastState();
  }

  onMessage(msg: string, conn: Party.Connection) {
    let data: any;
    try { data = JSON.parse(msg); } catch { return; }

    const seat = this.findSeatByConn(conn.id);

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
      const prev = this.state.seats[idx] as Extract<Seat, { kind: "human" }>;
      this.state.seats[idx] = { kind: "bot", name: prev.name, color: prev.color };
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

  // Drop human seats whose connection is no longer live. Covers the case
  // where a tab closes hard (OS kill, crash, network loss) and onClose
  // doesn't fire cleanly — prevents "ghost" seats from blocking lobby
  // logic for other players.
  private reapStaleSeats(): boolean {
    const active = new Set<string>();
    for (const c of this.room.getConnections()) active.add(c.id);
    let changed = false;
    for (let i = 0; i < this.state.seats.length; i++) {
      const s = this.state.seats[i];
      if (s.kind === "human" && !active.has(s.id)) {
        const prev = s;
        this.state.seats[i] = { kind: "bot", name: prev.name, color: prev.color };
        changed = true;
      }
    }
    return changed;
  }

  // ---- state machine ----
  private tick() {
    const now = Date.now();
    // Clean up ghost seats first so the "all ready" check below is honest.
    if (this.reapStaleSeats()) {
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
