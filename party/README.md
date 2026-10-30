# Trashure Island — game server

Runs on Cloudflare as a [PartyServer](https://github.com/cloudflare/partykit/tree/main/packages/partyserver)
Durable Object. It moved here after hosted PartyKit shut down on 23 Oct 2026 and
deleted its data.

## What it does

One Durable Object per room, reached at `/parties/main/<room>`:

| Room | Purpose |
|---|---|
| `global` | Multiplayer world over WebSocket: seats, sessions, garbage, pirates, whale |
| `consents` | Email consents and the leaderboard. Holds personal data |
| `runs` | Anonymous research recordings, see `docs/RUNS_SCHEMA.md` |

Storage stays in the EU (`DO_JURISDICTION` in `wrangler.jsonc`). Don't change that
value once the server holds data: rooms under another jurisdiction are different
objects, so the existing data would become unreachable.

The admin endpoints need the `ADMIN_TOKEN` secret:

- `consents?action=admin&token=…`
- `runs?action=runs_export&token=…` (or use `scripts/export_runs.py`)

## Deploy

### First time, from your machine

```bash
cd party
npm ci
npx wrangler login
npx wrangler deploy
npx wrangler secret put ADMIN_TOKEN
```

`wrangler deploy` prints the Worker URL. Put its host in `BACKEND_HOST` in
`trashure-fury.html` and `DEFAULT_BASE` in `scripts/export_runs.py`. Those are the
only two places the address lives.

### After that

`.github/workflows/deploy-party.yml` redeploys on every push to `main` that changes
`party/`. It needs two repo secrets at
<https://github.com/Biutopic/Trashure-Island/settings/secrets/actions>:

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the Workers overview page |

## Local development

```bash
cd party
npm ci
cp .dev.vars.example .dev.vars
npx wrangler dev --port 8787
```

Then serve the repo root with any static server and open
`trashure-fury.html?backend=127.0.0.1:8787`. The `?backend=` override only works on
localhost. Local workerd doesn't implement jurisdictions, which is why
`.dev.vars` leaves `DO_JURISDICTION` empty.

`npm run typecheck` regenerates the binding types and runs `tsc`.

## Changing the Durable Object class

Wrangler doesn't generate migrations. If you add, rename or remove a server class,
add an entry to `migrations` in `wrangler.jsonc`.
