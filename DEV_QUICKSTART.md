# Dev quickstart

Local end-to-end exercise of the dashboard — no AWS, no Mac mini, no
real iMessage capture. Six seeded devices covering every health
state (healthy, warning, silent, critical, paused, revoked), plus a
queued command you can cancel and a completed diagnose command.

## Prereqs

- `pnpm` 10+ (`npm install -g pnpm@10`)
- `supabase` CLI (`brew install supabase/tap/supabase`)
- `node` 22+
- `openssl`, `psql` (both come with Supabase CLI / stock macOS)

## One command

```bash
./scripts/dev-bootstrap.sh
```

That will:

1. `supabase start` (skipped if already up).
2. Apply every migration in `supabase/migrations/`.
3. Generate a P-256 command-signing keypair into `.dev-secrets/`
   (gitignored).
4. Write `apps/dashboard/.env.local` with every required var.
5. Seed a demo firm + 6 devices + a couple commands + audit rows.

Won't clobber an existing `.env.local`; if you have one it tells you
what needs to be in it.

## Run the dashboard

```bash
pnpm --filter @archiveglp/dashboard dev
# → http://localhost:3001
```

Log in with any email (MVP mock auth; no password). The session
cookie is `secure` only in production, so plain HTTP on localhost
works without mkcert.

## What to click

| URL | What you're exercising |
| --- | --- |
| `/devices` | Fleet overview. 6 summary cards (healthy / warning / silent / critical / paused / revoked). Silent = "agent alive but no messages in hours" — the exact state the original question was about. |
| `/devices/dev_seed_silent` | Device detail. Try **Diagnose** — sample result already populated. |
| `/devices/dev_seed_critical` | Has a **queued** diagnose command → hit "Cancel". |
| `/devices/dev_seed_healthy` | Try **Pause** (not destructive, no step-up). Then **Resume**. |
| `/devices/dev_seed_healthy` | Try **Revoke** — prompts for step-up password. Default: `stepup-local` (see `.env.local`). |
| `/audit` | Filterable audit log. Viewing this page writes an audit row too. |
| `/login` | Mock login — any email, no password. |

## Gotchas

- **Seeded devices can't actually heartbeat.** Their `public_key_spki_b64`
  is a dummy. Calls to `POST /api/v1/heartbeat` from a real agent
  won't authenticate against the seed. For real capture, follow
  `apps/agent/MAC_MINI_SETUP.md` on a Mac.
- **Silent detection grace window:** newly-enrolled devices (enrolled
  < 4h ago) are not flagged silent. The seed uses `enrolled_at = now()
  - interval '14 days'` for the silent device so it fires immediately.
- **Destructive actions require `SUPERVISOR_STEPUP_PASSWORD`.** The
  bootstrap sets this; if you delete it from `.env.local`, destructive
  commands fail closed with 503 (this is intentional).
- **Command-signing key lives in `.dev-secrets/`.** Never commit. Rotate
  by `rm -rf .dev-secrets/ apps/dashboard/.env.local && ./scripts/dev-bootstrap.sh`.

## Tear down

```bash
supabase stop
# or to wipe the local database entirely:
supabase db reset
```

## Real Mac agent

Once you've verified the UI, `apps/agent/MAC_MINI_SETUP.md` walks
through the real macOS agent setup — pairing code, first-run
disclosure, iMessage capture, heartbeat, command execution. The
bootstrap above leaves Supabase in a state the agent can enroll
against.
