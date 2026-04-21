import crypto from 'node:crypto';

/**
 * Canonical signing string (v1). MUST stay in sync with
 * apps/agent/archiveglp_agent/signing.py.
 *
 *   METHOD\n
 *   PATH\n
 *   UNIX_TIMESTAMP\n
 *   BODY_SHA256_HEX
 *
 * Any format change is a breaking protocol version; bump header names
 * rather than silently drifting.
 */
export function canonicalString(
  method: string,
  path: string,
  timestamp: number,
  bodySha256: string,
): Buffer {
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${timestamp}\n${bodySha256}`);
}

export function bodySha256Hex(body: string | Buffer): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

export interface SignedRequestHeaders {
  deviceId: string;
  timestamp: number;
  bodySha256: string;
  signatureB64: string;
}

export function extractSignedHeaders(headers: Record<string, string | undefined>):
  | { ok: true; value: SignedRequestHeaders }
  | { ok: false; reason: string } {
  const device = headers['x-archiveglp-device'] ?? headers['X-ArchiveGLP-Device'];
  const ts = headers['x-archiveglp-timestamp'] ?? headers['X-ArchiveGLP-Timestamp'];
  const hash = headers['x-archiveglp-body-sha256'] ?? headers['X-ArchiveGLP-Body-Sha256'];
  const sig = headers['x-archiveglp-signature'] ?? headers['X-ArchiveGLP-Signature'];
  if (!device || !ts || !hash || !sig) {
    return { ok: false, reason: 'missing signing headers' };
  }
  const tsN = Number(ts);
  if (!Number.isFinite(tsN)) return { ok: false, reason: 'invalid timestamp' };
  return {
    ok: true,
    value: { deviceId: device, timestamp: tsN, bodySha256: hash, signatureB64: sig },
  };
}

export const FRESHNESS_WINDOW_SECONDS = 300;

export function isFresh(timestamp: number, now: Date): boolean {
  const drift = Math.abs(Math.floor(now.getTime() / 1000) - timestamp);
  return drift <= FRESHNESS_WINDOW_SECONDS;
}

/**
 * Verifies an ECDSA P-256 over SHA-256 signature (DER, base64-encoded)
 * against an SPKI-encoded (DER, base64-encoded) public key.
 */
export function verifySignature(
  publicKeySpkiB64: string,
  method: string,
  path: string,
  timestamp: number,
  bodySha256: string,
  signatureB64: string,
): boolean {
  const spkiDer = Buffer.from(publicKeySpkiB64, 'base64');
  const key = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const sig = Buffer.from(signatureB64, 'base64');
  const verifier = crypto.createVerify('sha256');
  verifier.update(canonicalString(method, path, timestamp, bodySha256));
  verifier.end();
  return verifier.verify({ key, dsaEncoding: 'der' }, sig);
}
