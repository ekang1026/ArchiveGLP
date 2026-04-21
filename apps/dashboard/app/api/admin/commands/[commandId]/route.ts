import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { recordAudit } from '../../../../../lib/audit';
import { getApiSession } from '../../../../../lib/auth';
import { requireSameOrigin } from '../../../../../lib/same-origin';
import { serverConfig, serviceClient } from '../../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * DELETE /api/admin/commands/:commandId
 *
 * Cancels a queued-but-not-yet-delivered command. Useful when a
 * supervisor misclicks `revoke` on the wrong device, or queues a
 * reboot for a device that's sitting offline. Cancels are an ack in
 * disguise: they set completed_at + error so the agent never sees
 * the row (GET filter is completed_at IS NULL), and the dashboard
 * shows *why* it never ran.
 *
 * Refuses to cancel once the server has handed the row to the agent
 * (delivered_at IS NOT NULL). At that point the side-effect may have
 * already executed; cancellation would be a lie.
 */

interface Params {
  params: Promise<{ commandId: string }>;
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const origin = requireSameOrigin(req);
  if (!origin.ok) {
    return NextResponse.json(
      { error: 'cross-origin request rejected', reason: origin.reason },
      { status: 403 },
    );
  }

  const session = await getApiSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { commandId } = await params;
  if (!commandId) {
    return NextResponse.json({ error: 'missing command_id' }, { status: 400 });
  }

  const cfg = serverConfig();
  const sb = serviceClient();

  const { data: cmd, error: lookupErr } = await sb
    .from('pending_command')
    .select('command_id, device_id, action, firm_id, delivered_at, completed_at')
    .eq('command_id', commandId)
    .eq('firm_id', cfg.FIRM_ID)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (!cmd) {
    return NextResponse.json({ error: 'command not found' }, { status: 404 });
  }
  if (cmd.completed_at) {
    return NextResponse.json(
      { error: 'already_completed', completed_at: cmd.completed_at },
      { status: 409 },
    );
  }
  if (cmd.delivered_at) {
    return NextResponse.json(
      { error: 'already_delivered', delivered_at: cmd.delivered_at },
      { status: 409 },
    );
  }

  const nowIso = new Date().toISOString();
  const { error: updateErr } = await sb
    .from('pending_command')
    .update({
      completed_at: nowIso,
      error: `canceled by ${session.email}`,
    })
    .eq('command_id', commandId)
    // Re-check delivered_at IS NULL so a concurrent GET /v1/commands
    // that just delivered the row doesn't lose the race to cancel.
    .is('delivered_at', null)
    .is('completed_at', null);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'command_canceled',
    targetType: 'device',
    targetId: cmd.device_id,
    metadata: {
      command_id: cmd.command_id,
      command_action: cmd.action,
    },
  });

  return new NextResponse(null, { status: 204 });
}
