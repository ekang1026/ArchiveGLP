import { Heartbeat } from '@archiveglp/schema';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { authenticateAgentRequest } from '../../../../lib/agent-auth';
import { serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * POST /api/v1/heartbeat
 *
 * Authenticated via device signature. Updates the device row with live
 * telemetry. The agent can optionally include OS/machine fields that
 * we added to the schema (os_version, hostname, uptime_seconds,
 * disk_free_gb, memory_free_mb, messages_app_running, fda_status);
 * any omitted fields leave existing values untouched.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAgentRequest(req, '/v1/heartbeat');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status ?? 401 });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(auth.body);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = Heartbeat.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const hb = parsed.data;
  const device = auth.device!;

  if (
    hb.firm_id !== device.firm_id ||
    hb.employee_id !== device.employee_id ||
    hb.device_id !== device.device_id
  ) {
    return NextResponse.json({ error: 'heartbeat/device mismatch' }, { status: 403 });
  }

  const sb = serviceClient();
  const update: Record<string, unknown> = {
    last_heartbeat_at: hb.reported_at,
    last_captured_at: hb.last_captured_at,
    status: hb.status,
    queue_depth: hb.queue_depth,
    clock_skew_ms: hb.clock_skew_ms,
    os_version: hb.os_version,
    agent_version: hb.agent_version,
  };
  // Optional fields: only overwrite the DB when the agent reported a
  // value. Without this guard, an older agent that doesn't send
  // `paused` would clear the column on every heartbeat — and the
  // remediation UI would show "Pause" after we had paused.
  if (hb.paused !== undefined) update.paused = hb.paused;
  const { error } = await sb
    .from('device')
    .update(update)
    .eq('device_id', device.device_id)
    .eq('firm_id', device.firm_id);
  if (error) {
    return NextResponse.json({ error: 'update failed' }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
