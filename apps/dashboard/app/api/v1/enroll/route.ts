import { EnrollmentRequest } from '@archiveglp/schema';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { loadCommandSigner } from '../../../../lib/command-signing';
import { serverConfig, serviceClient } from '../../../../lib/supabase';

export const runtime = 'nodejs';

/**
 * POST /api/v1/enroll
 *
 * The one unauthenticated agent endpoint. Auth'd by possession of a
 * single-use pairing_code that a firm admin issued via /api/admin/
 * pending-enrollments. Device signature auth begins at the next request.
 */
export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = EnrollmentRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'schema', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { pairing_code, attestation } = parsed.data;

  const cfg = serverConfig();
  if (attestation.firm_id !== cfg.FIRM_ID) {
    return NextResponse.json({ error: 'firm_id mismatch' }, { status: 403 });
  }

  const sb = serviceClient();

  // Find and consume the pairing code.
  const { data: pending, error: pendingErr } = await sb
    .from('pending_enrollment')
    .select('firm_id, employee_id, employee_email, employee_full_name, expires_at, used_at')
    .eq('pairing_code', pairing_code)
    .maybeSingle();
  if (pendingErr || !pending) {
    return NextResponse.json({ error: 'invalid pairing_code' }, { status: 403 });
  }
  if (pending.used_at) {
    return NextResponse.json({ error: 'pairing_code already used' }, { status: 403 });
  }
  if (new Date(pending.expires_at) < new Date()) {
    return NextResponse.json({ error: 'pairing_code expired' }, { status: 403 });
  }
  if (
    pending.firm_id !== attestation.firm_id ||
    pending.employee_id !== attestation.employee_id ||
    pending.employee_email.toLowerCase() !== attestation.employee_email.toLowerCase()
  ) {
    return NextResponse.json(
      { error: 'pairing_code bound to different employee' },
      { status: 403 },
    );
  }

  // Refuse re-enroll of an existing device.
  const { data: existing } = await sb
    .from('device')
    .select('device_id')
    .eq('device_id', attestation.device_id)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ error: 'device already enrolled' }, { status: 409 });
  }

  // Upsert firm + employee to satisfy FKs, then insert device, then
  // consume the pairing code. Supabase doesn't expose transactions via
  // the JS client; we accept that this sequence is best-effort atomic.
  // If any step after device-insert fails, a replay of the same
  // pairing_code will now hit "already used" — which is the correct
  // behavior.
  const nowIso = new Date().toISOString();

  const { error: firmErr } = await sb
    .from('firm')
    .upsert(
      {
        firm_id: attestation.firm_id,
        display_name: attestation.firm_id,
        retention_years: 3,
      },
      { onConflict: 'firm_id', ignoreDuplicates: true },
    );
  if (firmErr) return NextResponse.json({ error: 'firm upsert' }, { status: 500 });

  const { error: empErr } = await sb.from('employee').upsert(
    {
      employee_id: attestation.employee_id,
      firm_id: attestation.firm_id,
      email: pending.employee_email,
      full_name: pending.employee_full_name,
      enrolled_at: nowIso,
      active: true,
    },
    { onConflict: 'employee_id' },
  );
  if (empErr) return NextResponse.json({ error: 'employee upsert' }, { status: 500 });

  const { error: devErr } = await sb.from('device').insert({
    device_id: attestation.device_id,
    firm_id: attestation.firm_id,
    employee_id: attestation.employee_id,
    public_key_spki_b64: attestation.device_public_key_spki_b64,
    os_version: attestation.os_version,
    agent_version: attestation.agent_version,
    enrolled_at: nowIso,
    status: 'healthy',
  });
  if (devErr) return NextResponse.json({ error: 'device insert' }, { status: 500 });

  await sb
    .from('pending_enrollment')
    .update({ used_at: nowIso, used_by_device_id: attestation.device_id })
    .eq('pairing_code', pairing_code);

  await sb.from('audit_log').insert({
    firm_id: attestation.firm_id,
    actor_type: 'system',
    actor_id: 'enroll',
    action: 'device_enrolled',
    target_type: 'device',
    target_id: attestation.device_id,
    metadata: {
      employee_email: pending.employee_email,
      attested_name: attestation.employee_full_name_typed,
      disclosures_version: attestation.disclosures_version,
      attested_at: attestation.attested_at,
    },
  });

  // Return the backend's command-signing public key. The pairing code
  // just got consumed, so this response is the one-shot authenticated
  // opportunity to hand the key to the agent without TOFU. The agent
  // persists it and uses it to verify every subsequent remediation
  // command. Fail closed: if signing is misconfigured, refuse to
  // enroll — the alternative is enrolling a device that can never
  // safely accept a remediation command.
  const signer = loadCommandSigner();
  return NextResponse.json(
    {
      server_command_key_id: signer.keyId,
      server_command_key_spki_b64: signer.publicKeySpkiB64(),
    },
    { status: 200 },
  );
}
