import { Heartbeat } from '@archiveglp/schema';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { Db, num, str, ts } from './lib/db.js';
import { bodySha256Hex } from './lib/signing.js';

const Env = z.object({
  FIRM_ID: z.string(),
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

export interface HeartbeatDeps {
  db: Db;
  firmId: string;
  now: () => Date;
}

/**
 * POST /v1/heartbeat. Agent emits every ~60s. Upserts device health into
 * the device table so the supervisor dashboard can render a live view.
 *
 * Missing device row is NOT auto-created here - enrollment is the only
 * path that registers a device public key. A heartbeat for an unknown
 * device returns 404 so operations can notice.
 */
export async function handle(
  event: APIGatewayProxyEventV2,
  deps: HeartbeatDeps,
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'empty body' });

  const claimed =
    event.headers['x-archiveglp-body-sha256'] ?? event.headers['X-ArchiveGLP-Body-Sha256'];
  if (claimed && bodySha256Hex(event.body) !== claimed) {
    return json(400, { error: 'body hash mismatch' });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid json' });
  }
  const parsed = Heartbeat.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'schema', details: parsed.error.flatten() });

  const hb = parsed.data;
  if (hb.firm_id !== deps.firmId) return json(403, { error: 'firm_id mismatch' });

  const res = await deps.db.execute(
    `UPDATE device
     SET last_heartbeat_at = :reported_at,
         last_captured_at = COALESCE(:last_captured_at, last_captured_at),
         status = :status,
         queue_depth = :queue_depth,
         clock_skew_ms = :clock_skew_ms,
         os_version = :os_version,
         agent_version = :agent_version
     WHERE device_id = :device_id AND firm_id = :firm_id`,
    [
      ts('reported_at', new Date(hb.reported_at)),
      hb.last_captured_at === null
        ? str('last_captured_at', null)
        : ts('last_captured_at', new Date(hb.last_captured_at)),
      str('status', hb.status),
      num('queue_depth', hb.queue_depth),
      num('clock_skew_ms', hb.clock_skew_ms),
      str('os_version', hb.os_version),
      str('agent_version', hb.agent_version),
      str('device_id', hb.device_id),
      str('firm_id', hb.firm_id),
    ],
  );

  if (res.numberOfRecordsUpdated === 0) {
    return json(404, { error: 'device not enrolled' });
  }
  return json(204, {});
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

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  return handle(event, { db, firmId: env.FIRM_ID, now: () => new Date() });
};
