'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { serverEnv } from '../../lib/env';
import { MAX_AGE_SECONDS, SESSION_COOKIE, issue } from '../../lib/session';

const LoginForm = z.object({ email: z.string().email() });

export async function loginAction(formData: FormData): Promise<void> {
  const parsed = LoginForm.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    redirect('/login?error=invalid_email');
  }
  const env = serverEnv();
  const token = issue(parsed.data.email, env.SESSION_SECRET);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
  redirect('/');
}
