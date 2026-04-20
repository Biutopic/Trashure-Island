# Trashure Island — PartyKit server

Real-time server for the multiplayer lobby / round state machine.

## What it does (today, Milestone 1 + 1.5)

- Runs a state machine per room: `LOBBY → COUNTDOWN → PLAYING → RECAP → LOBBY`.
- Assigns players to one of four seats. Empty seats are filled by `bot` placeholders so the leaderboard grid is always 4-wide.
- Tracks per-player "Ready" state. When every human is ready, the lobby countdown short-circuits to ~1.5 s.
- Drops a human seat back to a bot seat on disconnect; the round keeps running with whoever is there.
- Ignores rooms with zero humans (no bot-only games = no wasted compute).

**Gameplay itself is not yet networked.** Each client runs its own local simulation during the `PLAYING` phase. Milestone 2+ will move the world state (pirates, whale, garbage, scoring, combat) into this server.

## Deploy

First time only:

```bash
cd <repo-root>
npx partykit@latest login
npx partykit@latest deploy
```

PartyKit will give you a URL like `https://trashure-island.<your-github-username>.partykit.dev`. If that username isn't `biutopic`, update the constant `MP_DEFAULT_HOST` in `trashure-fury.html` to match.

## Local development

```bash
npx partykit dev
# then in another shell:
npx vite
# open http://localhost:8080/trashure-fury.html?mp=ws://127.0.0.1:1999/parties/main/global
```

The `?mp=` query string overrides the production WebSocket URL.

## Protocol (client ↔ server)

### Client → server

```jsonc
{ "type": "hello", "name": "Captain" }          // sent on connect
{ "type": "ready", "value": true }              // lobby phase only
```

### Server → client

```jsonc
{ "type": "spectator" }                         // 5th+ connection
{ "type": "state", "state": { /* RoomState */ } }
```

`RoomState` shape:

```ts
{
  phase: 'LOBBY' | 'COUNTDOWN' | 'PLAYING' | 'RECAP',
  phaseEndsAt: number,          // epoch ms
  seats: [                       // always length 4
    { kind: 'human', id, name, ready, color } |
    { kind: 'bot',   name, color } |
    { kind: 'empty' }
  ]
}
```

## Next milestones

2. Server-side world state (pirates, whale, hydronaute, garbage).
3. Boat movement sync + client prediction.
4. Pickups + scoring (server-authoritative).
5. Fireballs + bombs + mines + damage with friendly fire.
6. Shared recap.
7. Seat-swap mid-round (bot seat takes over when a human leaves).
8. Polish: spectator view, reconnect, rate limits.
