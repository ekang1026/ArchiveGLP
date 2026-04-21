import crypto from 'node:crypto';
import { IssuePairingCodeRequest } from '@archiveglp/schema';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { serverConfig, serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * POST /api/admin/pending-enrollments
 *
 * Issue a single-use pairing code. Authenticated with a shared admin
 * key in X-Admin-Key (constant-time compared against ADMIN_API_KEY env).
 * Upserts firm + employee rows so admin can bootstrap the roster
 * implicitly with the first pairing code per employee.
 */
export async function POST(req: NextRequest) {
  const cfg = serverConfig();
  const provided =
    req.headers.get('x-admin-key') ?? req.headers.get('X-Admin-Key') ?? '';
  if (!provided) {
    return NextResponse.json({ error: 'missing admin key' }, { status: 401 });
  }
  if (!constantTimeEq(provided, cfg.ADMIN_API_KEY)) {
    return NextResponse.json({ error: 'invalid admin key' }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const parsed = IssuePairingCodeRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const reqBody = parsed.data;
  if (reqBody.firm_id !== cfg.FIRM_ID) {
    return NextResponse.json({ error: 'firm_id mismatch' }, { status: 403 });
  }

  const pairingCode = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    Date.now() + reqBody.expires_in_hours * 3600_000,
  ).toISOString();

  const sb = serviceClient();

  await sb
    .from('firm')
    .upsert(
      { firm_id: reqBody.firm_id, display_name: reqBody.firm_id, retention_years: 3 },
      { onConflict: 'firm_id', ignoreDuplicates: true },
    );
  await sb.from('employee').upsert(
    {
      employee_id: reqBody.employee_id,
      firm_id: reqBody.firm_id,
      email: reqBody.employee_email,
      full_name: reqBody.employee_full_name,
      active: true,
    },
    { onConflict: 'employee_id' },
  );

  const { error } = await sb.from('pending_enrollment').insert({
    pairing_code: pairingCode,
    firm_id: reqBody.firm_id,
    employee_id: reqBody.employee_id,
    employee_email: reqBody.employee_email,
    employee_full_name: reqBody.employee_full_name,
    expires_at: expiresAt,
  });
  if (error) {
    return NextResponse.json({ error: 'insert failed' }, { status: 500 });
  }

  return NextResponse.json(
    { pairing_code: pairingCode, expires_at: expiresAt },
    { status: 201 },
  );
}
