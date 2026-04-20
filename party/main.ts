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
  | { kind: "human"; id: string; name: string; ready: boolean; color: string }
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
const LOBBY_MAX_MS     = 30_000; // max time to wait for more humans
const COUNTDOWN_MS     = 3_000;
const PLAYING_MS       = 180_000; // 3 minutes
const RECAP_MS         = 15_000;
const TICK_MS          = 250;     // state-machine tick cadence

const BOT_NAMES = ["Coral", "Marlin", "Triton", "Dory", "Splash", "Reef"];
const COLORS    = ["#ff5a3c", "#ffd93d", "#4ade80", "#22d3ee", "#c084fc", "#fb7185"];

function makeBotSeats(): Seat[] {
  const picks = [...BOT_NAMES].sort(() => Math.random() - 0.5).slice(0, 4);
  return picks.map((name, i) => ({ kind: "bot", name, color: COLORS[i % COLORS.length] } as Seat));
}

function initialState(): RoomState {
  return {
    phase: "LOBBY",
    phaseEndsAt: Date.now() + LOBBY_MAX_MS,
    seats: makeBotSeats(),
  };
}

// True iff every human in the lobby has clicked Ready. With zero humans,
// we wait the full LOBBY_MAX_MS before starting (no bot-only games).
function allHumansReady(state: RoomState): boolean {
  const humans = state.seats.filter((s) => s.kind === "human") as Extract<Seat, { kind: "human" }>[];
  if (humans.length === 0) return false;
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
  onConnect(conn: Party.Connection, _ctx: Party.ConnectionContext) {
    // Replace the first bot seat (or empty slot) with a placeholder
    // human. Display name + ready flag get filled in by the "hello"
    // message that follows immediately.
    const idx = this.state.seats.findIndex((s) => s.kind === "bot" || s.kind === "empty");
    if (idx === -1) {
      // All 4 seats are human — send them in as a spectator.
      conn.send(JSON.stringify({ type: "spectator" }));
      conn.send(JSON.stringify({ type: "state", state: this.state }));
      return;
    }
    const color = COLORS[idx % COLORS.length];
    this.state.seats[idx] = { kind: "human", id: conn.id, name: "Capitaine", ready: false, color };
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
      // Short-circuit the lobby countdown when every human is ready.
      if (allHumansReady(this.state)) {
        const quickStart = Date.now() + 1_500;
        if (quickStart < this.state.phaseEndsAt) this.state.phaseEndsAt = quickStart;
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
      // Ready-check may now pass if the dropped human was the blocker.
      if (this.state.phase === "LOBBY" && allHumansReady(this.state)) {
        const quickStart = Date.now() + 1_500;
        if (quickStart < this.state.phaseEndsAt) this.state.phaseEndsAt = quickStart;
      }
      this.broadcastState();
    }
    if (humanCount(this.state) === 0) {
      // No humans left: stop burning compute. A new connection will
      // restart the ticker via onConnect.
      this.stopTicker();
    }
  }

  // ---- state machine ----
  private tick() {
    if (Date.now() < this.state.phaseEndsAt) return;
    const now = Date.now();
    switch (this.state.phase) {
      case "LOBBY":
        if (humanCount(this.state) === 0) {
          // No one ever joined during the window — reset and idle.
          this.state = initialState();
          this.stopTicker();
        } else {
          this.state.phase = "COUNTDOWN";
          this.state.phaseEndsAt = now + COUNTDOWN_MS;
        }
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
        this.state.phaseEndsAt = now + LOBBY_MAX_MS;
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
