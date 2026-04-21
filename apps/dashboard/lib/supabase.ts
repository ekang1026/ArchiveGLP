import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const PublicEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

const ServerEnv = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  FIRM_ID: z.string().regex(/^firm_[a-z0-9]{6,32}$/),
  ADMIN_API_KEY: z.string().min(16),
});

/**
 * Service-role client. Bypasses RLS. Use ONLY from server code:
 * Route Handlers (app/api/**), server actions, server components.
 * Never import this into a client component.
 */
let cachedService: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (cachedService) return cachedService;
  const pub = PublicEnv.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  const srv = ServerEnv.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    FIRM_ID: process.env.FIRM_ID,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  });
  cachedService = createClient(pub.NEXT_PUBLIC_SUPABASE_URL, srv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedService;
}

export function serverConfig() {
  return ServerEnv.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    FIRM_ID: process.env.FIRM_ID,
    ADMIN_API_KEY: process.env.ADMIN_API_KEY,
  });
}
