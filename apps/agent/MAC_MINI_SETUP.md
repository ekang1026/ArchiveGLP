# Running the agent on a Mac mini (dev testing)

End-to-end smoke test of the ArchiveGLP macOS agent against a local stub
server. No AWS. No signing certificate. Intended for internal validation
before the signed `.pkg` distribution path lands.

## One-time setup

Prereqs on the Mac mini:

```bash
# Xcode command line tools (for Python build, git)
xcode-select --install

# Homebrew (skip if you already have it)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Python 3.11 and Node 22
brew install python@3.11 node@22 pnpm
```

Clone and install:

```bash
git clone <your-repo-url> ~/ArchiveGLP
cd ~/ArchiveGLP
pnpm install

# Python agent + dev extras
cd apps/agent
python3.11 -m venv .venv
.venv/bin/pip install -e '.[dev]'
```

## Grant Full Disk Access (required to read chat.db)

Messages writes `~/Library/Messages/chat.db` into a TCC-protected path. You
need to grant FDA to the binary that will read it:

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click **+**, navigate to `/usr/bin/python3` (or wherever your `python3.11`
   resolves — `readlink -f $(which python3.11)`).
3. Toggle it on.
4. Quit and reopen Terminal so the grant takes effect in a new process.

Verify:

```bash
sqlite3 ~/Library/Messages/chat.db "SELECT COUNT(*) FROM message LIMIT 1;"
# Should print a number. "Error: unable to open database file" means FDA
# was not granted to the process (or its parent).
```

## Run the end-to-end test (fixture data, no real iMessage)

From the repo root:

```bash
pnpm --filter @archiveglp/api e2e
```

This builds a synthetic `chat.db` fixture, starts the stub, runs the agent,
and asserts that 2 messages + 1 heartbeat arrive with valid signatures.
You should see:

```
E2E OK: 1 device enrolled, 2 messages, 1 heartbeats, 0 denials.
```

## Run the agent against YOUR real Messages.app data (manual)

For a real smoke test, point the agent at your own `chat.db` and run it
against the stub server:

### Terminal 1 — stub

```bash
cd ~/ArchiveGLP/apps/api
pnpm stub
# {"event":"stub.listening","port":4040}
```

### Terminal 2 — enroll

```bash
cd ~/ArchiveGLP/apps/agent
export ARCHIVEGLP_FIRM_ID=firm_devtest01
export ARCHIVEGLP_EMPLOYEE_ID=emp_devtester01
export ARCHIVEGLP_DEVICE_ID=dev_devmacmini1
export ARCHIVEGLP_API_BASE_URL=http://127.0.0.1:4040
# Leave chatdb path at its default (~/Library/Messages/chat.db)

.venv/bin/archiveglp-agent enroll
# Enter any pairing code (the stub accepts everything)
# Enter your work email
# Type your full name to attest
```

### Terminal 2 (same terminal) — run the pump

```bash
.venv/bin/archiveglp-agent run
# Ctrl-C to stop. Messages get forwarded in batches; check Terminal 1
# for `ingest.ok` lines and a count per batch.
```

### Terminal 3 — inspect what the stub received

```bash
curl -s http://127.0.0.1:4040/_state | jq '.messages[0]'
# Inspect a single message envelope to confirm fields and signatures
# landed correctly.

curl -s http://127.0.0.1:4040/_state | jq '{
  devices: (.devices | keys),
  message_count: (.messages | length),
  heartbeat_count: (.heartbeats | length),
  denials: .denials
}'
```

## What you're validating

- **Key generation + storage**: `~/Library/Application Support/ArchiveGLP/device.key`
  must exist and be `rw-------` (0600). `ls -la` to check.
- **Enrollment flow**: Disclosures show, typed-name attestation is
  required, no progress without it.
- **Signing**: Every forwarded batch has valid ECDSA P-256 signatures.
  The stub's `denials` array must stay empty. Anything non-empty is a
  Python↔TypeScript protocol drift and a bug to file.
- **Capture correctness**: A message you send on iMessage should appear
  in the stub within ~10 seconds (5s poll + up to 2s forwarder drain).
  The `body_text` should match verbatim. Inbound/outbound `direction`
  should match sender.
- **Heartbeat**: Stub logs a `heartbeat.ok` line at least every 60s.
- **Recovery**: `Ctrl-C` the agent, start it again. It resumes at its
  last ROWID (check the local SQLite state DB).

## Uninstall / reset

```bash
rm -rf ~/Library/Application\ Support/ArchiveGLP
# Optionally revoke FDA for python3 in System Settings.
```

## What this does NOT test

- Real AWS ingestion, Object Lock, archiver, Cognito, the dashboard.
- Attachment capture (not yet implemented).
- Signed/notarized `.pkg` distribution (waiting on Apple Developer cert).
- Multi-user group chats, edits, unsends — the pump handles single-row
  iMessages only in this MVP.

If the e2e test passes and the manual Mac mini test shows real iMessage
bodies round-tripping through the stub with no denials, the agent is
ready to be pointed at a real AWS deploy.
