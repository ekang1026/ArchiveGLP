import crypto from 'node:crypto';
import { IssuePairingCodeRequest } from '@archiveglp/schema';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { Db, num, str } from './lib/db.js';

const Env = z.object({
  FIRM_ID: z.string(),
  RETENTION_YEARS: z.coerce.number().int().min(3),
  ADMIN_KEY_SECRET_ARN: z.string(),
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

export interface AdminDeps {
  db: Db;
  now: () => Date;
  firmId: string;
  retentionYears: number;
  adminKey: string;
}

/**
 * POST /admin/pending-enrollments
 *
 * Authenticated by a shared secret in the X-Admin-Key header. For the MVP
 * this is a single firm-wide admin key stored in Secrets Manager; a Cognito-
 * backed admin group replaces it later. The key is constant-time compared.
 *
 * Side effects (all in one transaction):
 *   1. Upsert firm row (retention_years from Lambda env, authoritative).
 *   2. Upsert employee row.
 *   3. Generate 32 bytes of crypto-random, base32url-encoded pairing code.
 *   4. INSERT pending_enrollment with expires_at.
 */
export async function handle(
  event: APIGatewayProxyEventV2,
  deps: AdminDeps,
): Promise<APIGatewayProxyResultV2> {
  const provided = event.headers['x-admin-key'] ?? event.headers['X-Admin-Key'];
  if (!provided) return json(401, { error: 'missing admin key' });
  if (!constantTimeEq(provided, deps.adminKey)) {
    return json(403, { error: 'invalid admin key' });
  }

  if (!event.body) return json(400, { error: 'empty body' });
  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid json' });
  }
  const parsed = IssuePairingCodeRequest.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'schema', details: parsed.error.flatten() });
  const req = parsed.data;

  if (req.firm_id !== deps.firmId) return json(403, { error: 'firm_id mismatch' });

  const code = generatePairingCode();
  const issuedAt = deps.now();
  const expiresAt = new Date(issuedAt.getTime() + req.expires_in_hours * 3600_000);

  await deps.db.withTx(async (tx) => {
    await tx.execute(
      `INSERT INTO firm (firm_id, display_name, retention_years)
       VALUES (:firm_id, :firm_id, :retention)
       ON CONFLICT (firm_id) DO NOTHING`,
      [str('firm_id', req.firm_id), num('retention', deps.retentionYears)],
    );
    await tx.execute(
      `INSERT INTO employee (employee_id, firm_id, email, full_name, active)
       VALUES (:employee_id, :firm_id, :email, :full_name, TRUE)
       ON CONFLICT (employee_id) DO UPDATE
       SET email = EXCLUDED.email, full_name = EXCLUDED.full_name`,
      [
        str('employee_id', req.employee_id),
        str('firm_id', req.firm_id),
        str('email', req.employee_email),
        str('full_name', req.employee_full_name),
      ],
    );
    await tx.execute(
      `INSERT INTO pending_enrollment
         (pairing_code, firm_id, employee_id, employee_email, employee_full_name, expires_at)
       VALUES (:code, :firm_id, :employee_id, :email, :full_name, :expires_at)`,
      [
        str('code', code),
        str('firm_id', req.firm_id),
        str('employee_id', req.employee_id),
        str('email', req.employee_email),
        str('full_name', req.employee_full_name),
        // expires_at passed as ISO string with typeHint=TIMESTAMP via str() is wrong;
        // we need ts() - but our helper takes a Date. Inline it:
        {
          name: 'expires_at',
          typeHint: 'TIMESTAMP',
          value: { stringValue: expiresAt.toISOString().replace('T', ' ').replace('Z', '') },
        },
      ],
    );
  });

  return json(201, {
    pairing_code: code,
    expires_at: expiresAt.toISOString(),
  });
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * 32 bytes of crypto-random -> base32url without padding. ~160 bits of
 * entropy, safe as a bearer token until it's consumed or expires.
 */
function generatePairingCode(): string {
  const bytes = crypto.randomBytes(32);
  return bytes.toString('base64url');
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const db = new Db({
  resourceArn: env.DB_CLUSTER_ARN,
  secretArn: env.DB_SECRET_ARN,
  database: env.DB_NAME,
  ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
});

const secretsClient = new SecretsManagerClient(env.AWS_REGION ? { region: env.AWS_REGION } : {});
let cachedAdminKey: string | null = null;

async function loadAdminKey(): Promise<string> {
  if (cachedAdminKey) return cachedAdminKey;
  const resp = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: env.ADMIN_KEY_SECRET_ARN }),
  );
  cachedAdminKey = resp.SecretString ?? '';
  if (!cachedAdminKey) throw new Error('admin key secret has no SecretString');
  return cachedAdminKey;
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  const adminKey = await loadAdminKey();
  return handle(event, {
    db,
    now: () => new Date(),
    firmId: env.FIRM_ID,
    retentionYears: env.RETENTION_YEARS,
    adminKey,
  });
};
