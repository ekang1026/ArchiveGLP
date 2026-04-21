import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Minimal signed-cookie session. For MVP only - real Cognito integration
 * replaces this with OIDC-issued JWTs validated by server middleware.
 *
 * Cookie format: base64url(JSON).base64url(HMAC-SHA256(payload, secret))
 * Payload includes issued-at; caller enforces max-age on read.
 */

export const SESSION_COOKIE = 'archiveglp-session';
const MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

const Session = z.object({
  email: z.string().email(),
  iat: z.number().int(),
});
export type Session = z.infer<typeof Session>;

export function issue(email: string, secret: string, now: Date = new Date()): string {
  const payload: Session = { email, iat: Math.floor(now.getTime() / 1000) };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verify(
  cookieValue: string | undefined,
  secret: string,
  now: Date = new Date(),
): Session | null {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
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
  const check = Session.safeParse(parsed);
  if (!check.success) return null;
  const age = Math.floor(now.getTime() / 1000) - check.data.iat;
  if (age < 0 || age > MAX_AGE_SECONDS) return null;
  return check.data;
}

export { MAX_AGE_SECONDS };
