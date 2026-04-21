import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordAudit } from '../../../../lib/audit';
import { getApiSession } from '../../../../lib/auth';
import { serverConfig, serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * POST /api/admin/commands
 *
 * Supervisor-authenticated endpoint (signed session cookie). Inserts a
 * row into pending_command; the targeted agent picks it up on its next
 * /v1/commands poll, executes, and acks. Also appends an audit_log
 * record so every remediation action is retrievable under SEC 17a-4
 * supervisory-action audit requirements.
 *
 * Destructive actions (revoke, rotate_key, restart_machine) require
 * `confirm: true` in the body. This is a server-side guard; the UI
 * should also confirm, but defence-in-depth: never rely on the client
 * alone to gate an action that kicks people off machines.
 */

const Action = z.enum([
  'resync',
  'pause',
  'resume',
  'rotate_key',
  'revoke',
  'upgrade',
  'restart_agent',
  'restart_machine',
]);
type Action = z.infer<typeof Action>;

const DESTRUCTIVE: ReadonlySet<Action> = new Set(['revoke', 'rotate_key', 'restart_machine']);

const Body = z.object({
  device_id: z.string().min(1),
  action: Action,
  parameters: z.record(z.unknown()).nullish(),
  confirm: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const session = await getApiSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'schema', details: parsed.error.flatten() }, { status: 400 });
  }
  const { device_id, action, parameters, confirm } = parsed.data;

  if (DESTRUCTIVE.has(action) && !confirm) {
    return NextResponse.json(
      { error: 'confirmation required for destructive action', action },
      { status: 400 },
    );
  }

  const cfg = serverConfig();
  const sb = serviceClient();

  // Scope to the configured firm and ensure the device belongs to it.
  // Prevents a compromised supervisor session in one firm from issuing
  // commands to a device in another (future multi-tenant posture).
  const { data: device, error: lookupErr } = await sb
    .from('device')
    .select('device_id, firm_id, revoked_at')
    .eq('device_id', device_id)
    .eq('firm_id', cfg.FIRM_ID)
    .maybeSingle();
  if (lookupErr) {
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  if (!device) {
    return NextResponse.json({ error: 'device not found' }, { status: 404 });
  }
  if (device.revoked_at && action !== 'revoke') {
    // Already-revoked devices cannot be acted on further. revoke is
    // idempotent, so allow re-issuing it.
    return NextResponse.json(
      { error: 'device is revoked', revoked_at: device.revoked_at },
      { status: 409 },
    );
  }

  const { data: inserted, error: insertErr } = await sb
    .from('pending_command')
    .insert({
      firm_id: cfg.FIRM_ID,
      device_id,
      action,
      parameters: parameters ?? null,
      issued_by: session.email,
    })
    .select('command_id, issued_at')
    .single();
  if (insertErr || !inserted) {
    return NextResponse.json({ error: insertErr?.message ?? 'insert failed' }, { status: 500 });
  }

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'command_issued',
    targetType: 'device',
    targetId: device_id,
    metadata: {
      command_id: inserted.command_id,
      command_action: action,
      parameters: parameters ?? null,
    },
  });

  return NextResponse.json(inserted, { status: 201 });
}
