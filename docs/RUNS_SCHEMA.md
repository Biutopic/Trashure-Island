# Trashure Island research runs — schema v1

One **run** = one player's 3-minute round, recorded from the end of the countdown
to the game-over screen (or the page closing). Recorder: `_runRec` in
`trashure-fury.html`. Server: room `runs` in `party/main.ts`.

## Privacy

- Random per-run id (`rid`), regenerated every round. Nothing links a run to a
  name, email, leaderboard entry or another run from the same device.
- Start time and server receive time are rounded to the hour, so a run can't be
  matched to a consent record by timestamp.
- No user agent, IP or exact screen size is stored. The viewport is rounded to 100 px.
- Stored in its own server room, in the EU. It never shares storage with consents or scores.
- Opt-out: the "research" checkbox on the start menu is ticked by default and
  resets on every page load, so one kiosk player unticking it doesn't opt out
  the next player.

## Transport

The client POSTs a chunk every ~15 s of game time, plus a final one, as `text/plain`
JSON. Each chunk is stored under `run:<rid>:<seq>`, so posting it again overwrites
it. Unsent chunks wait in `localStorage["ti_run_pending"]` (max ~3 MB, oldest
dropped first) and are retried on the next load or `online` event.

```
{ kind:"run", v:1, rid, seq, fin, hdr? (seq 0 only), end? (fin only), f:[], o:[], e:[] }
```

`scripts/export_runs.py` merges the chunks back into one file per run.

## Units

- Time `t`: centiseconds since run start (game clock, which pauses with the game).
- Positions: world units × 10 (integers). The world is a disc of radius
  `hdr.world.r` = 160, centred on the island (radius 12).
- Angles: milliradians in [-π, π]. Heading convention matches the game:
  forward = (sin θ, cos θ) on (x, z).

## `hdr`: run header

| field | meaning |
|---|---|
| `v`, `build` | schema version, game build string |
| `hour` | start time, epoch ms rounded down to the hour |
| `lang` | `fr` / `en` |
| `mode` | `solo` / `mp` |
| `event` | tag from `?event=…` (e.g. `nantes-2026-06`), `""` for normal web play |
| `device` | input device at start: `kb` / `pad` / `touch` |
| `touch`, `pad` | touch-capable screen, gamepad connected |
| `view` | viewport [w, h], rounded to 100 px |
| `lq` | low-quality (TV / Xbox) mode |
| `world` | `{ r, island, dur, maxHp }` |

## `f`: pilot frames, 10 Hz

`[t, x, z, heading, hp, boost%, level, score, raw, eff, ax, ay]`

- `raw`: what the player pressed. `eff`: what the boat received. They differ
  while the engine is cranking and during respawn.
  Bits: 1 forward, 2 back, 4 left, 8 right, 16 boost, 32 fire.
  `eff` adds 64 = respawning, 128 = upgrade screen open.
- `ax`, `ay`: analog stick ×100 (gamepad or touch stick; 0 on keyboard).
  `ay` < 0 = up. The game itself only uses the thresholded bits.

## `o`: world observations, 5 Hz

`[t, [[id, x, z, heading, extra], …]]`, covering every moving actor.
`extra` = whale state (0 surface, 1 diving, 2 submerged, 3 surfacing) for the
whale, `1` if emerged for pirates, and HP for boats. The kind is declared once
by an `ent` event.

## `e`: events

| event | payload |
|---|---|
| `ent` | `t, id, kind` (`whale` / `hydro` / `bot` / `pirate` / `human`) |
| `g+` | `t, id, x, z, points, heal` (plastic appeared) |
| `gm` | `t, id, x, z` (plastic moved > 1 unit, e.g. magnet) |
| `g-` | `t, id` (plastic gone: collected by someone, or despawned) |
| `m+` / `m-` | sea mine `t, id, x, z` / `t, id` |
| `x+` / `x-` | pirate bomb `t, id, targetX, targetZ, originX, originZ` / `t, id` |
| `up` | `t, solar, speed, magnet` (player's upgrade levels) |
| `dev` | `t, device` (input device changed) |

Who collected a plastic piece is not logged. Work it out offline from the `g-`
time and the nearest boat in `f` / `o` at that moment.

## `end`: final chunk only

`{ reason: "complete" | "abandoned", t, score, level }`

## Caveats for analysis

- Arcade physics: on/off steering at a fixed turn rate, no inertia model. Use this
  data for **decisions** (target choice, avoidance timing and clearance,
  hesitation), not for boat handling.
- The first 30–60 s of most runs is the player learning the controls.
  Most players at events are first-timers.
- The in-game Hydronaute (`hydro`) follows a scripted loop. It is not the real
  autopilot.
