import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { recordAudit } from '../../../../lib/audit';
import { getApiSession } from '../../../../lib/auth';
import { serverEnv } from '../../../../lib/env';
import { requireSameOrigin } from '../../../../lib/same-origin';
import { STEPUP_COOKIE, verifyStepUp } from '../../../../lib/step-up';
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
  'diagnose',
]);
type Action = z.infer<typeof Action>;

const DESTRUCTIVE: ReadonlySet<Action> = new Set(['revoke', 'rotate_key', 'restart_machine']);

const Body = z.object({
  device_id: z.string().min(1),
  action: Action,
  parameters: z.record(z.unknown()).nullish(),
  confirm: z.boolean().optional(),
  // Override the 24h default on a per-command basis. Bounded so an
  // accidental `9999` doesn't create a permanent command.
  expires_in_hours: z.number().positive().max(24 * 30).optional(),
});

const DEFAULT_TTL_HOURS = 24;

export async function POST(req: NextRequest) {
  // CSRF: reject before touching cookies/session. The supervisor
  // cookie is SameSite=Lax which still allows some cross-site POST
  // vectors; Sec-Fetch-Site + Origin/Referer enforce same-origin at
  // the application layer.
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
  const { device_id, action, parameters, confirm, expires_in_hours } = parsed.data;

  if (DESTRUCTIVE.has(action) && !confirm) {
    return NextResponse.json(
      { error: 'confirmation required for destructive action', action },
      { status: 400 },
    );
  }

  // Destructive actions require a valid step-up cookie bound to the
  // current session. Forces an attacker with only a stolen cookie to
  // also re-authenticate before they can fire revoke / rotate_key /
  // restart_machine. Returns 401 with a known sentinel so the UI can
  // re-prompt for the step-up password and retry.
  if (DESTRUCTIVE.has(action)) {
    const env = serverEnv();
    const store = await cookies();
    const token = store.get(STEPUP_COOKIE)?.value;
    const ok = verifyStepUp(token, session.email, env.SESSION_SECRET);
    if (!ok) {
      return NextResponse.json(
        { error: 'step_up_required', action },
        { status: 401 },
      );
    }
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

  // Duplicate-suppression: if an open (not-yet-completed, not-yet-
  // expired) command of the same action already exists for this
  // device, refuse rather than queue a second one. Prevents the
  // "click Restart three times" storm without blocking the pause ->
  // resume sequence (those have different actions).
  const nowIso = new Date().toISOString();
  const { data: conflict, error: conflictErr } = await sb
    .from('pending_command')
    .select('command_id')
    .eq('device_id', device_id)
    .eq('action', action)
    .is('completed_at', null)
    .gt('expires_at', nowIso)
    .limit(1)
    .maybeSingle();
  if (conflictErr) {
    return NextResponse.json({ error: conflictErr.message }, { status: 500 });
  }
  if (conflict) {
    return NextResponse.json(
      {
        error: 'duplicate_open_command',
        action,
        open_command_id: conflict.command_id,
      },
      { status: 409 },
    );
  }

  const ttlHours = expires_in_hours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();

  const { data: inserted, error: insertErr } = await sb
    .from('pending_command')
    .insert({
      firm_id: cfg.FIRM_ID,
      device_id,
      action,
      parameters: parameters ?? null,
      issued_by: session.email,
      expires_at: expiresAt,
    })
    .select('command_id, issued_at, expires_at')
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
