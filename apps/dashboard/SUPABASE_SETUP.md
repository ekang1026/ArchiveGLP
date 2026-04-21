# ArchiveGLP on Supabase

The "fun project" deploy path. Uses Supabase (Postgres + Auth + Realtime)
as the backend, Next.js Route Handlers as the agent-facing API, and the
existing dashboard app as the UI. No AWS, no Object Lock, no WORM
guarantee — see the main `README.md` for the note about what that means.

## Architecture at a glance

```
  macOS agent  ──►  Next.js Route Handlers (apps/dashboard/app/api/**)
                    verifies ECDSA signatures, uses Supabase client
                                    │
                                    ▼
                           Supabase Postgres
                                    │
                                    ▼
  Dashboard UI  ◄──  Supabase Auth + Realtime  (apps/dashboard/app/**)
```

Agent protocol is unchanged from the AWS-tier design: same signed
headers, same canonical string, same schema. The only thing that moved
is what sits behind the HTTP endpoint.

## One-time setup (do this once per Supabase project)

### 1. Apply the schema

Supabase dashboard → **SQL Editor** → **New query** → paste the entire
contents of `supabase/migrations/20260421000000_archiveglp_schema.sql`
→ **Run**.

Verify: **Table Editor** should now show `firm`, `employee`, `device`,
`message_meta`, `attachment_meta`, `audit_log`, `pending_enrollment`,
`pending_command`.

### 2. Local env

On the Mac mini (the machine running the agent + the Next.js dev
server), create `apps/dashboard/.env.local` from `.env.example`. Fill
in all six variables:

- `NEXT_PUBLIC_SUPABASE_URL` — Settings → API → Project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Settings → API → anon public
- `SUPABASE_SERVICE_ROLE_KEY` — Settings → API → service_role secret
- `FIRM_ID` — e.g. `firm_archdev001` (must match `^firm_[a-z0-9]{6,32}$`)
- `ADMIN_API_KEY` — 48+ random chars (`openssl rand -base64 36`)
- `SESSION_SECRET` — 48+ random chars (`openssl rand -base64 48`)

`.env.local` is gitignored. `ADMIN_API_KEY` and `SESSION_SECRET` are
generated locally and never leave the machine.

### 3. Install deps + start the server

```bash
cd ~/ArchiveGLP
pnpm install
pnpm --filter @archiveglp/dashboard dev
# → Next.js dev server on http://localhost:3000
```

## Enroll a device (first time)

### Terminal 1 — keep `pnpm dev` running

### Terminal 2 — admin issues a pairing code

```bash
cd ~/ArchiveGLP
ADMIN_KEY=$(grep '^ADMIN_API_KEY=' apps/dashboard/.env.local | cut -d= -f2-)

curl -sS -X POST http://localhost:3000/api/admin/pending-enrollments \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{
    "firm_id": "firm_archdev001",
    "employee_id": "emp_eddie0001",
    "employee_email": "you@example.com",
    "employee_full_name": "Your Name",
    "expires_in_hours": 24
  }'
# → {"pairing_code":"...","expires_at":"..."}
```

Copy the `pairing_code`.

### Terminal 2 (or 3) — enroll the agent

```bash
cd ~/ArchiveGLP/apps/agent

# If you enrolled before against the stub, start fresh:
rm -rf ~/Library/Application\ Support/ArchiveGLP

export ARCHIVEGLP_FIRM_ID=firm_archdev001
export ARCHIVEGLP_EMPLOYEE_ID=emp_eddie0001
export ARCHIVEGLP_DEVICE_ID=dev_mini0000001
export ARCHIVEGLP_API_BASE_URL=http://localhost:3000/api

.venv/bin/archiveglp-agent enroll
# paste the pairing_code from the admin call
# paste your work email + typed name

.venv/bin/archiveglp-agent run
```

Send yourself an iMessage from your phone. Within ~10 seconds the
Next.js server logs should show `POST /api/v1/ingest` with status 202.

### Verify in Supabase

In the Supabase **Table Editor**:

- `device` → one row, `last_heartbeat_at` updates every minute
- `message_meta` → rows with real `body_text` (decoded from
  `attributedBody` if the message was composed in Messages.app)
- `audit_log` → a `device_enrolled` row from the moment you enrolled

## Issuing a command to the device

The agent polls `GET /api/v1/commands` every 30 seconds. You can
queue a command directly in SQL Editor:

```sql
insert into pending_command (firm_id, device_id, action, issued_by)
values ('firm_archdev001', 'dev_mini0000001', 'pause', 'manual-sql');
```

Within 30 seconds:

- Agent's log shows `commands.execute action=pause`
- Back in SQL Editor: `select * from pending_command order by issued_at desc limit 1`
  now has `delivered_at` and `completed_at` populated.
- `~/Library/Application Support/ArchiveGLP/paused` file exists.
- Pump is paused (heartbeats still tick, but no new messages enqueued).

Queue a `resume` the same way to unpause. Other supported actions:
`resync`, `revoke` (destructive — wipes device state).

## What's NOT built yet in this Supabase path

- **Dashboard pages for Supabase**: `app/messages/`, `app/devices/`
  still use the AWS-era direct-Data-API code and haven't been
  rewritten to use the Supabase client. UI will 500 until next slice.
- **Supabase Auth** for the dashboard. The mock signed-cookie login is
  still what's wired up.
- **Realtime subscriptions**. Postgres changes publish via Supabase
  Realtime; dashboard hasn't subscribed yet.
- **Command UI**. For now you issue commands via SQL.

Next slice: swap dashboard pages to Supabase client + add realtime +
add command-issue UI.
