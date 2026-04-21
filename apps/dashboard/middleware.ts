import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Presence check only. Cryptographic verification happens inside
 * `requireSession()` on each page (Node.js runtime). Middleware runs on
 * the Edge Runtime by default, where our HMAC util + Buffer imports would
 * add weight and pull node-crypto into the edge bundle. A two-layer check
 * (cookie present here, signature verified there) means any tampered
 * cookie still forces a /login redirect from the page.
 */
const PUBLIC_PATHS = new Set(['/login']);

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/public')
  ) {
    return NextResponse.next();
  }
  const hasSession = req.cookies.has('archiveglp-session');
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
