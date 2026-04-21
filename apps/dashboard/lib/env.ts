import { z } from 'zod';

/**
 * Public (client-exposed) env.
 */
const Env = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default('ArchiveGLP'),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
});

export const env = Env.parse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

/**
 * Server-only env, lazy-loaded so importing this module in client code
 * or at build time doesn't fail.
 */
const ServerEnv = z.object({
  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET must be at least 32 bytes of entropy'),
});

export type ServerEnv = z.infer<typeof ServerEnv>;

let cachedServer: ServerEnv | null = null;
export function serverEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  cachedServer = ServerEnv.parse({ SESSION_SECRET: process.env.SESSION_SECRET });
  return cachedServer;
}
