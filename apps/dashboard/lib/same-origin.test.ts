import type { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { requireSameOrigin } from './same-origin';

function make(headers: Record<string, string>): NextRequest {
  const h = new Headers(headers);
  return { headers: h } as unknown as NextRequest;
}

describe('requireSameOrigin', () => {
  it('accepts Sec-Fetch-Site: same-origin', () => {
    expect(requireSameOrigin(make({ 'sec-fetch-site': 'same-origin' })).ok).toBe(true);
  });

  it('rejects Sec-Fetch-Site: cross-site', () => {
    const r = requireSameOrigin(make({ 'sec-fetch-site': 'cross-site' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('cross-site');
  });

  it('rejects Sec-Fetch-Site: same-site (subdomain attack surface)', () => {
    expect(requireSameOrigin(make({ 'sec-fetch-site': 'same-site' })).ok).toBe(false);
  });

  it('falls back to Origin match when Sec-Fetch-Site absent', () => {
    expect(
      requireSameOrigin(
        make({ host: 'dashboard.example', origin: 'https://dashboard.example' }),
      ).ok,
    ).toBe(true);
  });

  it('rejects Origin on different host', () => {
    const r = requireSameOrigin(
      make({ host: 'dashboard.example', origin: 'https://attacker.test' }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('attacker.test');
  });

  it('falls back to Referer when no Origin', () => {
    expect(
      requireSameOrigin(
        make({ host: 'dashboard.example', referer: 'https://dashboard.example/devices' }),
      ).ok,
    ).toBe(true);
  });

  it('rejects when no origin/referer/sec-fetch-site', () => {
    const r = requireSameOrigin(make({ host: 'dashboard.example' }));
    expect(r.ok).toBe(false);
  });

  it('rejects malformed Origin', () => {
    expect(
      requireSameOrigin(make({ host: 'dashboard.example', origin: 'not-a-url' })).ok,
    ).toBe(false);
  });
});
