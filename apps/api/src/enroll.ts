import crypto from 'node:crypto';
import { EnrollmentRequest } from '@archiveglp/schema';
import type { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { Db, num, str } from './lib/db.js';
import { makeS3Client, putArchive } from './lib/s3.js';

const Env = z.object({
  FIRM_ID: z.string(),
  RETENTION_YEARS: z.coerce.number().int().min(3),
  ARCHIVE_BUCKET: z.string(),
  ARCHIVE_KEY_ARN: z.string(),
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

export interface EnrollDeps {
  s3: S3Client;
  db: Db;
  now: () => Date;
  firmId: string;
  retentionYears: number;
  bucket: string;
  kmsKeyId: string;
}

/**
 * POST /v1/enroll. The ONE unauthenticated endpoint. Authenticated by
 * possession of a one-time pairing_code row inserted by a firm admin.
 *
 * Flow, all inside one DB transaction:
 *   1. Find and lock the pending_enrollment row by pairing_code where
 *      used_at IS NULL AND expires_at > now().
 *   2. Verify the attestation's firm_id/employee_id/employee_email match
 *      the pairing code.
 *   3. Upsert the employee row (real data from the pairing code, not a
 *      placeholder).
 *   4. Refuse if a device row already exists with this device_id (re-
 *      enrollment of a different box is a new pairing code).
 *   5. INSERT device with the attested public key.
 *   6. Mark pending_enrollment used.
 * Then archive the attestation to S3 under Object Lock. The attestation
 * itself is a compliance record - regulators want to see informed consent.
 */
export async function handle(
  event: APIGatewayProxyEventV2,
  deps: EnrollDeps,
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) return json(400, { error: 'empty body' });
  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid json' });
  }
  const parsed = EnrollmentRequest.safeParse(raw);
  if (!parsed.success) return json(400, { error: 'schema', details: parsed.error.flatten() });
  const { pairing_code, attestation } = parsed.data;

  if (attestation.firm_id !== deps.firmId) {
    return json(403, { error: 'firm_id mismatch' });
  }

  try {
    await deps.db.withTx(async (tx) => {
      const row = await tx.execute(
        `SELECT firm_id, employee_id, employee_email, employee_full_name
         FROM pending_enrollment
         WHERE pairing_code = :code
           AND used_at IS NULL
           AND expires_at > now()
         FOR UPDATE`,
        [str('code', pairing_code)],
      );
      if (row.rows.length === 0) {
        throw new HandledError(403, 'invalid or expired pairing_code');
      }
      const [firmIdCol, employeeIdCol, emailCol, fullNameCol] = [
        row.rows[0]!['0'] as string,
        row.rows[0]!['1'] as string,
        row.rows[0]!['2'] as string,
        row.rows[0]!['3'] as string,
      ];
      if (
        firmIdCol !== attestation.firm_id ||
        employeeIdCol !== attestation.employee_id ||
        emailCol.toLowerCase() !== attestation.employee_email.toLowerCase()
      ) {
        throw new HandledError(403, 'pairing_code bound to different employee');
      }

      await tx.execute(
        `INSERT INTO firm (firm_id, display_name, retention_years)
         VALUES (:firm_id, :firm_id, :retention)
         ON CONFLICT (firm_id) DO NOTHING`,
        [str('firm_id', attestation.firm_id), num('retention', deps.retentionYears)],
      );

      await tx.execute(
        `INSERT INTO employee (employee_id, firm_id, email, full_name, enrolled_at, active)
         VALUES (:employee_id, :firm_id, :email, :full_name, now(), TRUE)
         ON CONFLICT (employee_id) DO UPDATE
         SET email = EXCLUDED.email,
             full_name = EXCLUDED.full_name,
             enrolled_at = COALESCE(employee.enrolled_at, EXCLUDED.enrolled_at),
             active = TRUE`,
        [
          str('employee_id', attestation.employee_id),
          str('firm_id', attestation.firm_id),
          str('email', emailCol),
          str('full_name', fullNameCol),
        ],
      );

      const existingDevice = await tx.execute(
        'SELECT 1 FROM device WHERE device_id = :device_id',
        [str('device_id', attestation.device_id)],
      );
      if (existingDevice.rows.length > 0) {
        throw new HandledError(409, 'device already enrolled');
      }

      await tx.execute(
        `INSERT INTO device (
           device_id, firm_id, employee_id, public_key_spki_b64,
           os_version, agent_version, enrolled_at, status
         ) VALUES (
           :device_id, :firm_id, :employee_id, :spki, :os, :agent, now(), 'healthy'
         )`,
        [
          str('device_id', attestation.device_id),
          str('firm_id', attestation.firm_id),
          str('employee_id', attestation.employee_id),
          str('spki', attestation.device_public_key_spki_b64),
          str('os', attestation.os_version),
          str('agent', attestation.agent_version),
        ],
      );

      await tx.execute(
        `UPDATE pending_enrollment
         SET used_at = now(), used_by_device_id = :device_id
         WHERE pairing_code = :code`,
        [str('device_id', attestation.device_id), str('code', pairing_code)],
      );
    });
  } catch (err) {
    if (err instanceof HandledError) {
      return json(err.status, { error: err.message });
    }
    throw err;
  }

  // Archive the attestation itself under Object Lock. This is a compliance
  // artifact; regulators ask to see it.
  const payload = JSON.stringify(attestation, Object.keys(attestation).sort());
  const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
  const issuedAt = deps.now();
  const retainUntil = new Date(issuedAt);
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + deps.retentionYears);
  const yyyy = issuedAt.getUTCFullYear();
  const mm = String(issuedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(issuedAt.getUTCDate()).padStart(2, '0');
  const key = `${attestation.firm_id}/_enrollments/${yyyy}/${mm}/${dd}/${attestation.device_id}-${payloadSha}.json`;

  await putArchive(deps.s3, {
    bucket: deps.bucket,
    key,
    body: payload,
    retainUntil,
    kmsKeyId: deps.kmsKeyId,
    contentType: 'application/json',
    metadata: {
      'firm-id': attestation.firm_id,
      'employee-id': attestation.employee_id,
      'device-id': attestation.device_id,
      'record-type': 'enrollment-attestation',
    },
  });

  return json(204, {});
}

class HandledError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const s3 = makeS3Client(env.AWS_REGION);
const db = new Db({
  resourceArn: env.DB_CLUSTER_ARN,
  secretArn: env.DB_SECRET_ARN,
  database: env.DB_NAME,
  ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
});

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  return handle(event, {
    s3,
    db,
    now: () => new Date(),
    firmId: env.FIRM_ID,
    retentionYears: env.RETENTION_YEARS,
    bucket: env.ARCHIVE_BUCKET,
    kmsKeyId: env.ARCHIVE_KEY_ARN,
  });
};
