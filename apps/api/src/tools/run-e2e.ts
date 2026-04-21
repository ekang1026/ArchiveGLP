/**
 * End-to-end test driver.
 *
 * 1. Starts the stub server in a child process on a free port.
 * 2. Builds a minimal SQLite fixture that mimics macOS chat.db.
 * 3. Runs the Python agent:
 *      - `archiveglp-agent enroll`   (pipes the pairing code + email + typed name)
 *      - `archiveglp-agent capture-once`
 *    directing ARCHIVEGLP_CHATDB_PATH at the fixture and API at the stub.
 * 4. Polls the stub's /_state until enrollment + ingest arrive, then asserts
 *    message shape and counts.
 *
 * This validates the Python <-> TypeScript boundary: schema shapes, canonical
 * signing string, body-hash header, ECDSA DER signatures, Apple-epoch
 * conversion, and the capture-to-forward path in-process. It does NOT
 * exercise AWS.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const AGENT_DIR = join(REPO_ROOT, 'apps/agent');
const AGENT_PY = join(AGENT_DIR, '.venv/bin/python');

interface StubState {
  devices: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  heartbeats: Array<Record<string, unknown>>;
  denials: Array<{ reason: string; path: string; at: string }>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no address'));
      }
    });
  });
}

function appleNs(dt: Date): bigint {
  const appleEpoch = Date.UTC(2001, 0, 1);
  return BigInt(dt.getTime() - appleEpoch) * 1_000_000n;
}

async function buildChatDbFixture(path: string): Promise<void> {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT, text TEXT, date INTEGER, date_edited INTEGER,
      handle_id INTEGER, is_from_me INTEGER, service TEXT,
      item_type INTEGER DEFAULT 0,
      associated_message_guid TEXT, associated_message_type INTEGER
    );
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, PRIMARY KEY (chat_id, message_id));

    INSERT INTO handle (ROWID, id, service) VALUES (1, '+15559876543', 'iMessage');
    INSERT INTO chat (ROWID, guid, chat_identifier, display_name)
      VALUES (1, 'iMessage;-;+15559876543', '+15559876543', NULL);
  `);

  const t1 = new Date('2026-04-21T18:00:00Z');
  const t2 = new Date('2026-04-21T18:01:00Z');
  const insertMsg = db.prepare(
    "INSERT INTO message (guid, text, date, handle_id, is_from_me, service, item_type) " +
      'VALUES (?, ?, ?, 1, ?, ?, 0)',
  );
  insertMsg.run('e2e-G1', 'E2E hi from client', appleNs(t1), 0, 'iMessage');
  insertMsg.run('e2e-G2', 'E2E hi from advisor', appleNs(t2), 1, 'iMessage');

  const linkMsg = db.prepare('INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?)');
  linkMsg.run(1);
  linkMsg.run(2);

  db.close();
}

function spawnStub(port: number): ChildProcess {
  const proc = spawn('pnpm', ['--silent', 'stub'], {
    cwd: join(REPO_ROOT, 'apps/api'),
    env: { ...process.env, STUB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => process.stdout.write(`[stub] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[stub-err] ${d}`));
  return proc;
}

async function waitForStub(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/_state`);
      if (r.ok) return;
    } catch {
      // keep polling
    }
    await delay(100);
  }
  throw new Error('stub did not come up within 15s');
}

async function getState(port: number): Promise<StubState> {
  const r = await fetch(`http://127.0.0.1:${port}/_state`);
  if (!r.ok) throw new Error(`/_state ${r.status}`);
  return r.json() as Promise<StubState>;
}

function runAgent(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(AGENT_PY, ['-m', 'archiveglp_agent', ...args], {
      cwd: AGENT_DIR,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
      process.stdout.write(`[agent] ${d}`);
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
      process.stderr.write(`[agent-err] ${d}`);
    });
    if (stdin) {
      proc.stdin?.write(stdin);
      proc.stdin?.end();
    }
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function main(): Promise<void> {
  const port = await freePort();
  const apiBase = `http://127.0.0.1:${port}`;

  const workdir = await mkdtemp(join(tmpdir(), 'archiveglp-e2e-'));
  const chatdb = join(workdir, 'chat.db');
  const stateDir = join(workdir, 'state');
  await buildChatDbFixture(chatdb);
  await writeFile(join(workdir, 'README'), 'ArchiveGLP e2e workdir\n');

  const stub = spawnStub(port);
  try {
    await waitForStub(port);

    const agentEnv = {
      ARCHIVEGLP_FIRM_ID: 'firm_e2etest01',
      ARCHIVEGLP_EMPLOYEE_ID: 'emp_e2ejane001',
      ARCHIVEGLP_DEVICE_ID: 'dev_e2emac00001',
      ARCHIVEGLP_API_BASE_URL: apiBase,
      ARCHIVEGLP_CHATDB_PATH: chatdb,
      ARCHIVEGLP_STATE_DIR: stateDir,
      ARCHIVEGLP_POLL_SECONDS: '1',
      ARCHIVEGLP_BATCH_SIZE: '50',
      ARCHIVEGLP_AGENT_VERSION: '0.0.1-e2e',
    };

    // `enroll` prompts for pairing code + email + typed name. Feed them over stdin.
    const enrollIn = ['pair-e2e-bypass-code-ok', 'e2e@firm.example', 'E2E Test User'].join('\n') + '\n';
    const enroll = await runAgent(['enroll'], agentEnv, enrollIn);
    if (enroll.code !== 0) throw new Error(`enroll exited with ${enroll.code}`);

    // One capture tick.
    const capture = await runAgent(['capture-once'], agentEnv);
    if (capture.code !== 0) throw new Error(`capture-once exited with ${capture.code}`);

    // capture-once enqueues locally; to actually flush to the server we need
    // to run the forwarder. The `run` daemon spins forwarder + pump + heartbeat
    // together, so we run it for a short window and then terminate.
    const run = spawn(AGENT_PY, ['-m', 'archiveglp_agent', 'run'], {
      cwd: AGENT_DIR,
      env: { ...process.env, ...agentEnv },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    try {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const state = await getState(port);
        if (state.messages.length >= 2 && state.heartbeats.length >= 1) break;
        await delay(500);
      }
    } finally {
      run.kill('SIGINT');
      await new Promise((r) => run.on('close', r));
    }

    const state = await getState(port);
    const problems: string[] = [];
    if (state.denials.length > 0) {
      problems.push(`authz denials: ${JSON.stringify(state.denials)}`);
    }
    if (Object.keys(state.devices).length !== 1) {
      problems.push(`expected 1 device, got ${Object.keys(state.devices).length}`);
    }
    if (state.messages.length < 2) {
      problems.push(`expected >=2 messages, got ${state.messages.length}`);
    }
    if (state.heartbeats.length < 1) {
      problems.push(`expected >=1 heartbeat, got ${state.heartbeats.length}`);
    }
    const bodies = state.messages.map((m) => String(m.body_text));
    if (!bodies.includes('E2E hi from client')) problems.push('missing inbound body');
    if (!bodies.includes('E2E hi from advisor')) problems.push('missing outbound body');

    if (problems.length > 0) {
      console.error('\nE2E FAILED:\n  ' + problems.join('\n  '));
      console.error('state:', JSON.stringify(state, null, 2));
      process.exit(1);
    }
    console.log(
      `\nE2E OK: 1 device enrolled, ${state.messages.length} messages, ${state.heartbeats.length} heartbeats, 0 denials.`,
    );
  } finally {
    stub.kill('SIGINT');
  }
}

main().catch((err) => {
  console.error('e2e.fatal', err);
  process.exit(1);
});
