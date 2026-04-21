import { describe, expect, it } from 'vitest';
import { MAX_AGE_SECONDS, issue, verify } from './session';

const SECRET = 'a'.repeat(64);

describe('session', () => {
  it('round-trips an issued token', () => {
    const now = new Date('2026-04-21T18:00:00Z');
    const token = issue('jane@firm.example', SECRET, now);
    const s = verify(token, SECRET, now);
    expect(s?.email).toBe('jane@firm.example');
    expect(s?.iat).toBe(Math.floor(now.getTime() / 1000));
  });

  it('rejects a token signed with a different secret', () => {
    const now = new Date('2026-04-21T18:00:00Z');
    const token = issue('jane@firm.example', SECRET, now);
    expect(verify(token, 'b'.repeat(64), now)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const now = new Date('2026-04-21T18:00:00Z');
    const token = issue('jane@firm.example', SECRET, now);
    const [, sig] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ email: 'evil@x', iat: 0 })).toString(
      'base64url',
    );
    expect(verify(`${forgedPayload}.${sig}`, SECRET, now)).toBeNull();
  });

  it('rejects an expired token', () => {
    const issued = new Date('2026-04-21T00:00:00Z');
    const token = issue('jane@firm.example', SECRET, issued);
    const later = new Date(issued.getTime() + (MAX_AGE_SECONDS + 60) * 1000);
    expect(verify(token, SECRET, later)).toBeNull();
  });

  it('rejects an undefined or malformed cookie', () => {
    expect(verify(undefined, SECRET)).toBeNull();
    expect(verify('not-a-valid-token', SECRET)).toBeNull();
    expect(verify('only.one.dot.too.many', SECRET)).toBeNull();
  });
});
