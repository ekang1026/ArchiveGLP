import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateAgentRequest } from '../../../../lib/agent-auth';
import { loadCommandSigner } from '../../../../lib/command-signing';
import { serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * GET  /api/v1/commands - fetch queued commands for the authenticated device.
 * POST /api/v1/commands    - agent acks a command's result.
 *
 * Delivery semantics are at-least-once. A command is (re-)returned to
 * the polling agent while it remains `completed_at IS NULL` and either
 * was never delivered or was last delivered more than
 * REDELIVERY_WINDOW_SECONDS ago. Each GET bumps `delivery_attempts`
 * and sets `last_delivered_at`. The agent must suppress duplicate
 * side-effects by command_id (it maintains a local executed-command
 * log) — otherwise a lost response followed by redelivery would run
 * the same action twice.
 */

// Server will re-offer an uncompleted command after this long. Must be
// comfortably longer than one agent poll interval so the normal path
// (agent receives -> executes -> acks) doesn't trigger redelivery.
const REDELIVERY_WINDOW_SECONDS = 90;

export async function GET(req: NextRequest) {
  const auth = await authenticateAgentRequest(req, '/v1/commands');
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status ?? 401 });
  }
  const device = auth.device!;
  const sb = serviceClient();

  const cutoffIso = new Date(Date.now() - REDELIVERY_WINDOW_SECONDS * 1000).toISOString();

  const { data, error } = await sb
    .from('pending_command')
    .select('command_id, action, parameters, issued_at, delivery_attempts')
    .eq('device_id', device.device_id)
    .is('completed_at', null)
    .or(`last_delivered_at.is.null,last_delivered_at.lt.${cutoffIso}`)
    .order('issued_at', { ascending: true })
    .limit(20);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const commands = data ?? [];

  if (commands.length > 0) {
    const nowIso = new Date().toISOString();
    await Promise.all(
      commands.map((c) =>
        sb
          .from('pending_command')
          .update({
            last_delivered_at: nowIso,
            delivered_at: c.delivery_attempts > 0 ? undefined : nowIso,
            delivery_attempts: (c.delivery_attempts ?? 0) + 1,
          })
          .eq('command_id', c.command_id),
      ),
    );
  }

  // Sign each command before handing it to the agent. The agent
  // refuses to execute commands that lack a valid signature from the
  // key_id it recorded at enrollment — this is the sole defense
  // against a MITM injecting `revoke` / `restart_machine` over a
  // compromised TLS path.
  const signer = loadCommandSigner();
  const outbound = commands.map(({ delivery_attempts: _a, ...rest }) => {
    const toSign = { ...rest, device_id: device.device_id };
    return {
      ...toSign,
      key_id: signer.keyId,
      signature_b64: signer.sign(toSign),
    };
  });
  return NextResponse.json({ commands: outbound });
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
  // Update only if this command belongs to the calling device. We
  // need `action` back so we can sync the corresponding `device`
  // column — otherwise the UI shows stale "Pause" when the device
  // is already paused, etc.
  const nowIso = new Date().toISOString();
  const { data: acked, error } = await sb
    .from('pending_command')
    .update({
      completed_at: nowIso,
      result: parsed.data.result ?? null,
      error: parsed.data.error ?? null,
    })
    .eq('command_id', parsed.data.command_id)
    .eq('device_id', device.device_id)
    .select('action')
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Sync device state off the ack, but only on success (no error on
  // the agent side). Without this the `paused` / `revoked_at`
  // columns drift from ground truth: the agent has the pause marker
  // set, but `device.paused` stays false because nothing writes it.
  if (acked && !parsed.data.error) {
    const deviceUpdate: Record<string, unknown> | null =
      acked.action === 'pause'
        ? { paused: true }
        : acked.action === 'resume'
          ? { paused: false }
          : acked.action === 'revoke'
            ? { revoked_at: nowIso, paused: false }
            : null;
    if (deviceUpdate) {
      await sb
        .from('device')
        .update(deviceUpdate)
        .eq('device_id', device.device_id)
        .eq('firm_id', device.firm_id);
    }
  }
  return new NextResponse(null, { status: 204 });
}
