import crypto from 'node:crypto';
import { ClientMessageEnvelope } from '@archiveglp/schema';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authenticateAgentRequest } from '../../../../lib/agent-auth';
import { serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * POST /api/v1/ingest
 *
 * Authenticated via device signature. Writes straight to message_meta.
 * No queue, no archiver separation — Postgres is the sink.
 *
 * archive_seq comes from a Postgres sequence (nextval). The canonical
 * JSON and its sha256 go into payload_sha256 + raw_source for
 * auditability and potential rehydration.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAgentRequest(req, '/v1/ingest');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status ?? 401 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(auth.body);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = ClientMessageEnvelope.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const envelope = parsed.data;
  const device = auth.device!;

  // Every message must match the authenticated device's firm + employee +
  // device. Defense in depth against a device trying to forge captures
  // on behalf of another employee.
  for (const m of envelope.messages) {
    if (
      m.firm_id !== device.firm_id ||
      m.employee_id !== device.employee_id ||
      m.device_id !== device.device_id
    ) {
      return NextResponse.json({ error: 'message/device mismatch' }, { status: 403 });
    }
  }

  const ingestedAt = new Date().toISOString();
  const sb = serviceClient();

  // Allocate one archive_seq per message via a single RPC-like query.
  // Supabase doesn't expose server-side transactions via the JS client,
  // so we call a Postgres function. Define one:
  //    create function next_archive_seqs(n int) returns setof bigint
  //    language sql as $$ select nextval('archive_seq') from generate_series(1, n) $$;
  // For now allocate one at a time — fine at personal-project scale.

  const rowsToInsert = [];
  for (const m of envelope.messages) {
    const payload = JSON.stringify(m, Object.keys(m).sort());
    const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');

    const { data: seq, error: seqErr } = await sb.rpc('next_archive_seq');
    if (seqErr || typeof seq !== 'number') {
      return NextResponse.json({ error: 'archive_seq allocation' }, { status: 500 });
    }

    rowsToInsert.push({
      archive_seq: seq,
      message_id: m.message_id,
      firm_id: m.firm_id,
      employee_id: m.employee_id,
      device_id: m.device_id,
      source: m.source,
      conversation_id: m.conversation_id,
      direction: m.direction,
      from_handle: m.from.handle,
      to_handles: m.to.map((h) => h.handle),
      body_text: m.body_text,
      unsent: m.unsent,
      captured_at: m.captured_at,
      ingested_at: ingestedAt,
      payload_sha256: payloadSha,
      raw_source: m.raw_source ?? null,
    });
  }

  // Duplicate detection: (firm_id, message_id) is UNIQUE. On conflict
  // we ignore so resending the same batch is safe.
  const { error: insertErr } = await sb.from('message_meta').upsert(rowsToInsert, {
    onConflict: 'firm_id,message_id',
    ignoreDuplicates: true,
  });
  if (insertErr) {
    return NextResponse.json(
      { error: 'insert failed', details: insertErr.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ accepted: envelope.messages.length }, { status: 202 });
}
