import type { NextRequest } from 'next/server';

/**
 * CSRF guard for cookie-authenticated mutating endpoints.
 *
 * Browsers send `Sec-Fetch-Site` on fetch/XHR (Chrome 76+, Firefox 90+,
 * Safari 16.4+). Any value other than `same-origin` means the request
 * crossed an origin boundary and we should reject — cookies ride along
 * with it on SameSite=Lax + same-site top-level navigations, so the
 * header is our real protection.
 *
 * When the header is absent (old clients, CLIs, curl) we fall back to
 * a strict Origin / Referer check against the request's own Host. The
 * fallback is intentionally strict: we'd rather break a curl script
 * that can easily set `Origin:` than leave a gap.
 *
 * Does NOT apply to endpoints authenticated via header tokens
 * (X-Admin-Key, device signatures, etc.) — browsers don't auto-attach
 * those, so cross-site POSTs can't forge them.
 */
export interface SameOriginResult {
  ok: boolean;
  reason?: string;
}

export function requireSameOrigin(req: NextRequest): SameOriginResult {
  const sfs = req.headers.get('sec-fetch-site');
  if (sfs) {
    // `same-origin` is the only value we accept. `same-site`,
    // `cross-site`, and `none` all represent a boundary crossing.
    if (sfs !== 'same-origin') {
      return { ok: false, reason: `sec-fetch-site=${sfs}` };
    }
    return { ok: true };
  }

  // Fallback: compare Origin or Referer to the request's Host.
  const host = req.headers.get('host');
  if (!host) return { ok: false, reason: 'missing host' };

  const origin = req.headers.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.host !== host) {
        return { ok: false, reason: `origin host ${parsed.host} != ${host}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'malformed origin' };
    }
  }

  const referer = req.headers.get('referer');
  if (referer) {
    try {
      const parsed = new URL(referer);
      if (parsed.host !== host) {
        return { ok: false, reason: `referer host ${parsed.host} != ${host}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, reason: 'malformed referer' };
    }
  }

  // No Origin, no Referer, no Sec-Fetch-Site. We cannot tell where
  // the request came from — fail closed.
  return { ok: false, reason: 'no origin/referer/sec-fetch-site' };
}
