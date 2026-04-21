import { z } from 'zod';

/**
 * Environment contract for the dashboard. Values are populated at deploy time
 * from the firm's CDK outputs. Public vars are exposed to the client; all
 * other names are server-only.
 *
 * We parse at module load so a missing value fails fast.
 */
const Env = z.object({
  // Public (client-exposed)
  NEXT_PUBLIC_APP_NAME: z.string().default('ArchiveGLP'),
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: z.string().optional(),
  NEXT_PUBLIC_COGNITO_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_AWS_REGION: z.string().optional(),
  NEXT_PUBLIC_FIRM_ID: z.string().optional(),
});

export const env = Env.parse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  NEXT_PUBLIC_COGNITO_USER_POOL_ID: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
  NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  NEXT_PUBLIC_AWS_REGION: process.env.NEXT_PUBLIC_AWS_REGION,
  NEXT_PUBLIC_FIRM_ID: process.env.NEXT_PUBLIC_FIRM_ID,
});

/**
 * Server-only env. Access only from server components, route handlers,
 * server actions, and middleware (Node.js runtime).
 */
const ServerEnv = z.object({
  FIRM_ID: z.string(),
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 bytes of entropy'),
});

export type ServerEnv = z.infer<typeof ServerEnv>;

let cachedServer: ServerEnv | null = null;

/**
 * Lazy server env load. Keeps server env out of the client bundle and
 * delays validation until a page/route actually touches it.
 */
export function serverEnv(): ServerEnv {
  if (cachedServer) return cachedServer;
  cachedServer = ServerEnv.parse({
    FIRM_ID: process.env.FIRM_ID,
    DB_CLUSTER_ARN: process.env.DB_CLUSTER_ARN,
    DB_SECRET_ARN: process.env.DB_SECRET_ARN,
    DB_NAME: process.env.DB_NAME,
    AWS_REGION: process.env.AWS_REGION,
    SESSION_SECRET: process.env.SESSION_SECRET,
  });
  return cachedServer;
}
