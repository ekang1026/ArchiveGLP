import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordAudit } from '../../../../lib/audit';
import { getApiSession } from '../../../../lib/auth';
import { serverEnv } from '../../../../lib/env';
import { requireSameOrigin } from '../../../../lib/same-origin';
import { STEPUP_COOKIE, STEPUP_TTL_SECONDS, constantTimeEq, issueStepUp } from '../../../../lib/step-up';

export const runtime = 'nodejs';

/**
 * POST /api/admin/step-up
 *
 * Re-authenticates the current supervisor by requiring them to
 * re-enter the shared stepup password. On success, sets a
 * short-lived `archiveglp-stepup` cookie that /api/admin/commands
 * checks before executing destructive actions.
 *
 * Requires SUPERVISOR_STEPUP_PASSWORD env. If unset, destructive
 * actions are effectively disabled (the cookie cannot be issued),
 * which is a fail-closed posture — preferable to silently granting
 * cookie-only access to revoke/reboot.
 */

const Body = z.object({ password: z.string().min(1) });

export async function POST(req: NextRequest) {
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

  const expected = process.env.SUPERVISOR_STEPUP_PASSWORD;
  if (!expected) {
    return NextResponse.json(
      { error: 'step-up unavailable: SUPERVISOR_STEPUP_PASSWORD not set' },
      { status: 503 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'schema' }, { status: 400 });
  }

  if (!constantTimeEq(parsed.data.password, expected)) {
    // Record failures so repeated bad-password attempts are visible
    // in the audit log. Intentionally doesn't include the attempted
    // password — only the email + source.
    await recordAudit({
      actorType: 'supervisor',
      actorId: session.email,
      action: 'login',
      targetType: 'stepup',
      targetId: session.email,
      metadata: { result: 'failed' },
    });
    return NextResponse.json({ error: 'invalid password' }, { status: 403 });
  }

  const env = serverEnv();
  const token = issueStepUp(session.email, env.SESSION_SECRET);

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'login',
    targetType: 'stepup',
    targetId: session.email,
    metadata: { result: 'granted' },
  });

  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(STEPUP_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: STEPUP_TTL_SECONDS,
  });
  return res;
}
