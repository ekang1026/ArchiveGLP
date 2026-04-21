import { z } from 'zod';

/**
 * Environment contract for the dashboard. Values are populated at deploy time
 * from the firm's CDK outputs (Cognito user pool id, client id, region).
 *
 * We parse at module load so a missing value fails fast.
 */
const Env = z.object({
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
