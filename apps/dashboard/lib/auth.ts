import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverEnv } from './env';
import { SESSION_COOKIE, type Session, verify } from './session';

/**
 * Returns the current session or redirects to /login. Call at the top of
 * every protected server component.
 */
export async function requireSession(): Promise<Session> {
  const env = serverEnv();
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  const session = verify(value, env.SESSION_SECRET);
  if (!session) redirect('/login');
  return session;
}
