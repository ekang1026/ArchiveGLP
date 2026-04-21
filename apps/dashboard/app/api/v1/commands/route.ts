import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateAgentRequest } from '../../../../lib/agent-auth';
import { serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * GET  /api/v1/commands - fetch queued commands for the authenticated device.
 *                        Marks fetched commands delivered_at=now.
 * POST /api/v1/commands/<id>/ack - agent acks a command's result.
 *
 * The agent polls GET on each heartbeat. Each command is returned once
 * (filtered by delivered_at IS NULL) to avoid running it repeatedly
 * across restarts. The ack endpoint stamps completed_at + result/error.
 */

export async function GET(req: NextRequest) {
  const auth = await authenticateAgentRequest(req, '/v1/commands');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status ?? 401 });
  }
  const device = auth.device!;
  const sb = serviceClient();

  const { data, error } = await sb
    .from('pending_command')
    .select('command_id, action, parameters, issued_at')
    .eq('device_id', device.device_id)
    .is('delivered_at', null)
    .is('completed_at', null)
    .order('issued_at', { ascending: true })
    .limit(20);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const commands = data ?? [];

  if (commands.length > 0) {
    const ids = commands.map((c) => c.command_id);
    await sb
      .from('pending_command')
      .update({ delivered_at: new Date().toISOString() })
      .in('command_id', ids);
  }

  return NextResponse.json({ commands });
}

const AckBody = z.object({
  command_id: z.string().uuid(),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateAgentRequest(req, '/v1/commands');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status ?? 401 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(auth.body);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = AckBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema', details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sb = serviceClient();
  const device = auth.device!;
  // Update only if this command belongs to the calling device.
  const { error } = await sb
    .from('pending_command')
    .update({
      completed_at: new Date().toISOString(),
      result: parsed.data.result ?? null,
      error: parsed.data.error ?? null,
    })
    .eq('command_id', parsed.data.command_id)
    .eq('device_id', device.device_id);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}
