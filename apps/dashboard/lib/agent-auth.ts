import type { NextRequest } from 'next/server';
import { bodySha256Hex, extractSignedHeaders, isFresh, verifySignature } from './signing';
import { serviceClient, serverConfig } from './supabase';

export interface AuthenticatedDevice {
  device_id: string;
  employee_id: string;
  firm_id: string;
}

export interface AuthResult {
  ok: boolean;
  device?: AuthenticatedDevice;
  body: string;
  reason?: string;
  status?: number;
}

/**
 * Verifies an incoming agent request:
 *   1. Has the required signed headers.
 *   2. Timestamp within the 5-minute freshness window.
 *   3. Signed body hash matches the actual body bytes (defense in depth).
 *   4. Signature verifies against the device's registered SPKI pubkey.
 *   5. Device is not revoked and belongs to this tenant firm.
 *
 * Returns both the authenticated device and the raw body (for
 * handlers that need to parse it without re-reading the stream).
 */
export async function authenticateAgentRequest(
  req: NextRequest,
  path: string,
): Promise<AuthResult> {
  const body = await req.text();
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });

  const extracted = extractSignedHeaders(headers);
  if (!extracted.ok) {
    return { ok: false, body, reason: extracted.reason, status: 401 };
  }
  const { deviceId, timestamp, bodySha256, signatureB64 } = extracted.value;

  if (!isFresh(timestamp, new Date())) {
    return { ok: false, body, reason: 'stale-timestamp', status: 401 };
  }
  if (bodySha256Hex(body) !== bodySha256) {
    return { ok: false, body, reason: 'body-hash-mismatch', status: 400 };
  }

  const cfg = serverConfig();
  const sb = serviceClient();
  const { data, error } = await sb
    .from('device')
    .select('device_id, employee_id, firm_id, public_key_spki_b64, revoked_at')
    .eq('device_id', deviceId)
    .eq('firm_id', cfg.FIRM_ID)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, body, reason: 'unknown-device', status: 401 };
  }
  if (data.revoked_at) {
    return { ok: false, body, reason: 'device-revoked', status: 403 };
  }

  const ok = verifySignature(
    data.public_key_spki_b64,
    req.method,
    path,
    timestamp,
    bodySha256,
    signatureB64,
  );
  if (!ok) return { ok: false, body, reason: 'bad-signature', status: 401 };

  return {
    ok: true,
    body,
    device: {
      device_id: data.device_id,
      employee_id: data.employee_id,
      firm_id: data.firm_id,
    },
  };
}
