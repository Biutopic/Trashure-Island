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

### First time (one-time, from your machine)

```bash
cd <repo-root>
npx partykit@latest login      # opens a browser, auth with GitHub
npx partykit@latest deploy
```

PartyKit will print a URL like `https://trashure-island.<your-github-username>.partykit.dev`. Update `MP_DEFAULT_HOST` in `trashure-fury.html` to match.

### After that (auto-deploy via GitHub Actions)

The `.github/workflows/deploy-party.yml` workflow redeploys PartyKit on every push that changes `party/`, `partykit.json`, or the workflow itself. No more manual deploys.

**One-time secret setup** in the repo's GitHub settings:

1. Open **https://github.com/Biutopic/Trashure-Island/settings/secrets/actions**
2. Click **New repository secret**, add two secrets:

   | Name | Value |
   |------|-------|
   | `PARTYKIT_LOGIN` | Your PartyKit username (e.g. `basiloco`) |
   | `PARTYKIT_TOKEN` | The `access_token` value from `~/.partykit/config.json` |

3. Where to find the token (Windows):
   - Open `C:\Users\<you>\.partykit\config.json` in Notepad
   - Copy the value of `"access_token"` (long string, don't include the quotes)
   - Paste as `PARTYKIT_TOKEN`
   - The `login` field in the same file is what goes in `PARTYKIT_LOGIN`

4. Trigger a deploy to verify: push any small change under `party/` OR open the **Actions** tab and manually run **"Deploy PartyKit server"** via the *workflow_dispatch* button.

If you ever rotate the token (`npx partykit logout && login`), update the `PARTYKIT_TOKEN` secret with the new value.

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
