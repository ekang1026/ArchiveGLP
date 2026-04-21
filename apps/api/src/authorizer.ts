import type { APIGatewayRequestAuthorizerEventV2, APIGatewaySimpleAuthorizerResult } from 'aws-lambda';
import { z } from 'zod';
import { Db, str } from './lib/db.js';
import { extractSignedHeaders, isFresh, verifySignature } from './lib/signing.js';

const Env = z.object({
  FIRM_ID: z.string(),
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

export interface AuthorizerDeps {
  db: Db;
  now: () => Date;
  firmId: string;
}

export interface AuthorizerResult extends APIGatewaySimpleAuthorizerResult {
  context?: {
    device_id: string;
    employee_id: string;
    firm_id: string;
  };
}

/**
 * API Gateway v2 HTTP API simple Lambda authorizer. Verifies the signed
 * headers attached by the agent, looks up the device's registered public
 * key, and authorizes the request on a successful signature check.
 *
 * Caching is disabled at the route level (resultsCacheTtl: 0) because
 * replay of a cached allow would bypass timestamp-freshness.
 *
 * The downstream handler MUST additionally verify that the claimed
 * X-ArchiveGLP-Body-Sha256 matches the actual body bytes - the
 * authorizer cannot see the body.
 */
export async function handle(
  event: APIGatewayRequestAuthorizerEventV2,
  deps: AuthorizerDeps,
): Promise<AuthorizerResult> {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers[k.toLowerCase()] = v;
  }

  const extracted = extractSignedHeaders(headers);
  if (!extracted.ok) return deny('missing-headers');
  const { deviceId, timestamp, bodySha256, signatureB64 } = extracted.value;

  if (!isFresh(timestamp, deps.now())) return deny('stale-timestamp');

  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  const row = await deps.db.execute(
    `SELECT public_key_spki_b64, employee_id, firm_id
     FROM device
     WHERE device_id = :device_id AND firm_id = :firm_id`,
    [str('device_id', deviceId), str('firm_id', deps.firmId)],
  );
  if (row.rows.length === 0) return deny('unknown-device');

  const spki = row.rows[0]!['0'] as string;
  const employeeId = row.rows[0]!['1'] as string;
  const firmId = row.rows[0]!['2'] as string;

  let ok = false;
  try {
    ok = verifySignature(spki, method, path, timestamp, bodySha256, signatureB64);
  } catch {
    ok = false;
  }
  if (!ok) return deny('bad-signature');

  return {
    isAuthorized: true,
    context: { device_id: deviceId, employee_id: employeeId, firm_id: firmId },
  };
}

function deny(reason: string): AuthorizerResult {
  console.warn('authorizer.deny', { reason });
  return { isAuthorized: false };
}

const db = new Db({
  resourceArn: env.DB_CLUSTER_ARN,
  secretArn: env.DB_SECRET_ARN,
  database: env.DB_NAME,
  ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
});

export const handler = async (
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<AuthorizerResult> => {
  return handle(event, { db, now: () => new Date(), firmId: env.FIRM_ID });
};
