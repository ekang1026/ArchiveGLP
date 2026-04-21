/**
 * Local end-to-end stub that mimics the firm-stack API with no AWS.
 *
 * Implements:
 *   POST /v1/enroll      - unauthenticated; records device pubkey.
 *   POST /v1/ingest      - verifies agent signature; stores messages.
 *   POST /v1/heartbeat   - verifies agent signature; stores heartbeat.
 *   GET  /_state         - dumps received data so the test driver can assert.
 *
 * Signature verification runs the real apps/api/src/lib/signing.ts code
 * path so this catches protocol drift between the Python agent and the
 * TypeScript server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  bodySha256Hex,
  extractSignedHeaders,
  isFresh,
  verifySignature,
} from '../lib/signing.js';

interface EnrolledDevice {
  device_id: string;
  employee_id: string;
  firm_id: string;
  spki_b64: string;
  enrolled_at: string;
}

interface StubState {
  devices: Record<string, EnrolledDevice>;
  messages: unknown[];
  heartbeats: unknown[];
  denials: { reason: string; path: string; at: string }[];
}

const state: StubState = { devices: {}, messages: [], heartbeats: [], denials: [] };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function lowerHeaders(h: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

function requireSignature(
  method: string,
  path: string,
  headers: Record<string, string | undefined>,
  body: string,
): { ok: true; device: EnrolledDevice } | { ok: false; reason: string } {
  const extracted = extractSignedHeaders(headers);
  if (!extracted.ok) return { ok: false, reason: extracted.reason };

  const { deviceId, timestamp, bodySha256, signatureB64 } = extracted.value;
  if (bodySha256 !== bodySha256Hex(body)) {
    return { ok: false, reason: 'body-hash-mismatch' };
  }
  if (!isFresh(timestamp, new Date())) return { ok: false, reason: 'stale-timestamp' };

  const device = state.devices[deviceId];
  if (!device) return { ok: false, reason: 'unknown-device' };

  const ok = verifySignature(device.spki_b64, method, path, timestamp, bodySha256, signatureB64);
  if (!ok) return { ok: false, reason: 'bad-signature' };
  return { ok: true, device };
}

async function handleEnroll(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { pairing_code?: string; attestation?: Record<string, unknown> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(res, 400, { error: 'invalid json' });
  }
  const att = parsed.attestation;
  if (!att || typeof att !== 'object') return send(res, 400, { error: 'missing attestation' });
  const deviceId = att.device_id as string;
  const employeeId = att.employee_id as string;
  const firmId = att.firm_id as string;
  const spki = att.device_public_key_spki_b64 as string;
  if (!deviceId || !spki) return send(res, 400, { error: 'missing keys' });
  state.devices[deviceId] = {
    device_id: deviceId,
    employee_id: employeeId,
    firm_id: firmId,
    spki_b64: spki,
    enrolled_at: new Date().toISOString(),
  };
  console.log(
    JSON.stringify({ event: 'enroll.ok', device_id: deviceId, employee_id: employeeId }),
  );
  return send(res, 204, {});
}

async function handleSignedPost(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  onBody: (body: Record<string, unknown>, device: EnrolledDevice) => void,
): Promise<void> {
  const body = await readBody(req);
  const headers = lowerHeaders(req.headers);
  const sig = requireSignature(req.method ?? 'POST', path, headers, body);
  if (!sig.ok) {
    state.denials.push({ reason: sig.reason, path, at: new Date().toISOString() });
    console.log(JSON.stringify({ event: 'authz.deny', path, reason: sig.reason }));
    return send(res, 401, { error: sig.reason });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return send(res, 400, { error: 'invalid json' });
  }
  if (!parsed || typeof parsed !== 'object') return send(res, 400, { error: 'bad body' });
  onBody(parsed as Record<string, unknown>, sig.device);
  return send(res, 204, {});
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (req.method === 'POST' && path === '/v1/enroll') return handleEnroll(req, res);
    if (req.method === 'POST' && path === '/v1/ingest') {
      return handleSignedPost(req, res, path, (envelope, device) => {
        const messages = (envelope.messages as unknown[]) ?? [];
        console.log(
          JSON.stringify({
            event: 'ingest.ok',
            device_id: device.device_id,
            count: messages.length,
          }),
        );
        for (const m of messages) state.messages.push(m);
      });
    }
    if (req.method === 'POST' && path === '/v1/heartbeat') {
      return handleSignedPost(req, res, path, (hb, device) => {
        state.heartbeats.push(hb);
        console.log(
          JSON.stringify({
            event: 'heartbeat.ok',
            device_id: device.device_id,
            queue_depth: hb.queue_depth,
          }),
        );
      });
    }
    if (req.method === 'GET' && path === '/_state') return send(res, 200, state);
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('stub.error', err);
    send(res, 500, { error: 'internal' });
  }
}

const port = Number(process.env.STUB_PORT ?? 4040);
const server = createServer((req, res) => {
  void handle(req, res);
});
server.listen(port, () => {
  console.log(JSON.stringify({ event: 'stub.listening', port }));
});
