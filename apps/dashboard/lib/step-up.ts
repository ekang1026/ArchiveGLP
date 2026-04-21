import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Step-up re-authentication for destructive remediation actions
 * (revoke, rotate_key, restart_machine).
 *
 * Threat model: a stolen supervisor session cookie (12h TTL) would
 * otherwise be enough to wipe every device key or reboot every Mac
 * in the fleet. A re-entered password — with a short-lived cookie
 * bound to the same session email — forces an attacker with only a
 * cookie to also obtain the password (or phish again) before they
 * can fire a destructive command.
 *
 * Format mirrors `lib/session.ts`:
 *   base64url(JSON({email, iat})).base64url(HMAC-SHA256)
 * but:
 *   - keyed under a distinct context string so a session HMAC cannot
 *     be replayed as a step-up HMAC even if SESSION_SECRET leaks in a
 *     future code path that only handles one of them,
 *   - TTL is 5 minutes, not 12 hours,
 *   - SameSite=Strict (we never want it sent on any cross-site nav).
 */

export const STEPUP_COOKIE = 'archiveglp-stepup';
export const STEPUP_TTL_SECONDS = 5 * 60;
const HMAC_CONTEXT = 'archiveglp.stepup.v1';

const Token = z.object({
  email: z.string().email(),
  iat: z.number().int(),
});
export type StepUpToken = z.infer<typeof Token>;

function hmac(secret: string, payloadB64: string): string {
  return crypto
    .createHmac('sha256', `${HMAC_CONTEXT}:${secret}`)
    .update(payloadB64)
    .digest('base64url');
}

export function issueStepUp(email: string, secret: string, now: Date = new Date()): string {
  const payload: StepUpToken = { email, iat: Math.floor(now.getTime() / 1000) };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(secret, payloadB64);
  return `${payloadB64}.${sig}`;
}

export function verifyStepUp(
  cookieValue: string | undefined,
  expectedEmail: string,
  secret: string,
  now: Date = new Date(),
): StepUpToken | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expected = hmac(secret, payloadB64);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  const check = Token.safeParse(parsed);
  if (!check.success) return null;
  if (check.data.email.toLowerCase() !== expectedEmail.toLowerCase()) return null;
  const age = Math.floor(now.getTime() / 1000) - check.data.iat;
  if (age < 0 || age > STEPUP_TTL_SECONDS) return null;
  return check.data;
}

export function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
