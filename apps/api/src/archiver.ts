import crypto from 'node:crypto';
import { Message } from '@archiveglp/schema';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { z } from 'zod';
import { Db, num, str, textArray, ts } from './lib/db.js';
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

/**
 * Ingested message: output of the ingest Lambda. Extends Message with a
 * server-assigned ingested_at. archive_seq is assigned HERE, not earlier,
 * because the sequence is monotonic and only needs to be unique once we
 * actually archive.
 */
const IngestedMessage = Message.extend({
  ingested_at: z.string().datetime(),
});
type IngestedMessage = z.infer<typeof IngestedMessage>;

export interface ArchiverDeps {
  s3: S3Client;
  db: Db;
  now: () => Date;
  firmId: string;
  retentionYears: number;
  bucket: string;
  kmsKeyId: string;
}

/**
 * Canonical payload used both for S3 storage and for the content-addressed
 * S3 key. Keeping these byte-identical makes the S3 put idempotent across
 * SQS redelivery.
 */
function canonicalPayload(m: IngestedMessage): string {
  // Stable key ordering. JSON.stringify with sorted keys is enough for our
  // flat-ish shape; nested arrays are already inherently ordered.
  return JSON.stringify(m, Object.keys(m).sort());
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function s3KeyFor(m: IngestedMessage, payloadSha: string): string {
  const d = new Date(m.ingested_at);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${m.firm_id}/${yyyy}/${mm}/${dd}/${payloadSha}.json`;
}

/**
 * Archive one message. Idempotent across retries via:
 *   1. Content-addressed S3 key (same bytes -> same key; S3 put is idempotent).
 *   2. Postgres UNIQUE (firm_id, message_id) with ON CONFLICT DO NOTHING.
 */
export async function archiveOne(deps: ArchiverDeps, m: IngestedMessage): Promise<void> {
  if (m.firm_id !== deps.firmId) {
    throw new Error(`firm_id mismatch: expected ${deps.firmId}, got ${m.firm_id}`);
  }

  const payload = canonicalPayload(m);
  const payloadSha = sha256Hex(payload);
  const s3Key = s3KeyFor(m, payloadSha);

  const retainUntil = new Date(deps.now());
  retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + deps.retentionYears);

  // S3 is the system of record. Put first. If Postgres fails afterward,
  // SQS redelivers, we re-put the same content-addressed key (no-op), and
  // re-attempt the metadata insert.
  await putArchive(deps.s3, {
    bucket: deps.bucket,
    key: s3Key,
    body: payload,
    retainUntil,
    kmsKeyId: deps.kmsKeyId,
    contentType: 'application/json',
    metadata: {
      'firm-id': m.firm_id,
      'employee-id': m.employee_id,
      'message-id': m.message_id,
      'payload-sha256': payloadSha,
    },
  });

  await deps.db.withTx(async (tx) => {
    const seqResult = await tx.execute("SELECT nextval('archive_seq') AS seq");
    const seqRaw = seqResult.rows[0]?.['0'];
    if (seqRaw === undefined || seqRaw === null) {
      throw new Error('failed to allocate archive_seq');
    }
    const archiveSeq = Number(seqRaw);

    // FK constraints require firm/employee/device rows to exist. Enrollment
    // creates them. In the MVP we upsert minimal rows on first sight so the
    // archiver is resilient to out-of-order enrollment.
    await tx.execute(
      `INSERT INTO firm (firm_id, display_name, retention_years)
       VALUES (:firm_id, :firm_id, :retention)
       ON CONFLICT (firm_id) DO NOTHING`,
      [str('firm_id', m.firm_id), num('retention', deps.retentionYears)],
    );
    await tx.execute(
      `INSERT INTO employee (employee_id, firm_id, email, full_name)
       VALUES (:employee_id, :firm_id, :placeholder_email, :placeholder_name)
       ON CONFLICT (employee_id) DO NOTHING`,
      [
        str('employee_id', m.employee_id),
        str('firm_id', m.firm_id),
        str('placeholder_email', `${m.employee_id}@pending-enrollment.invalid`),
        str('placeholder_name', m.employee_id),
      ],
    );
    await tx.execute(
      `INSERT INTO device (device_id, firm_id, employee_id, public_key_spki_b64, enrolled_at)
       VALUES (:device_id, :firm_id, :employee_id, :placeholder_key, now())
       ON CONFLICT (device_id) DO NOTHING`,
      [
        str('device_id', m.device_id),
        str('firm_id', m.firm_id),
        str('employee_id', m.employee_id),
        str('placeholder_key', 'pending-enrollment'),
      ],
    );

    const ins = await tx.execute(
      `INSERT INTO message_meta (
         archive_seq, message_id, firm_id, employee_id, device_id, source,
         conversation_id, direction, from_handle, to_handles, body_text, unsent,
         captured_at, ingested_at, s3_bucket, s3_key
       ) VALUES (
         :archive_seq, :message_id, :firm_id, :employee_id, :device_id, :source,
         :conversation_id, :direction, :from_handle, :to_handles::text[], :body_text, :unsent,
         :captured_at, :ingested_at, :s3_bucket, :s3_key
       )
       ON CONFLICT (firm_id, message_id) DO NOTHING`,
      [
        num('archive_seq', archiveSeq),
        str('message_id', m.message_id),
        str('firm_id', m.firm_id),
        str('employee_id', m.employee_id),
        str('device_id', m.device_id),
        str('source', m.source),
        str('conversation_id', m.conversation_id),
        str('direction', m.direction),
        str('from_handle', m.from.handle),
        textArray(
          'to_handles',
          m.to.map((h) => h.handle),
        ),
        str('body_text', m.body_text),
        { name: 'unsent', value: { booleanValue: m.unsent } },
        ts('captured_at', new Date(m.captured_at)),
        ts('ingested_at', new Date(m.ingested_at)),
        str('s3_bucket', deps.bucket),
        str('s3_key', s3Key),
      ],
    );

    if (ins.numberOfRecordsUpdated === 0) {
      // Already archived (redelivery after crash between S3 and DB). Release
      // the sequence number by ignoring it; gaps in archive_seq are acceptable.
      return;
    }
  });
}

export async function handle(event: SQSEvent, deps: ArchiverDeps): Promise<SQSBatchResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    try {
      const parsed = IngestedMessage.parse(JSON.parse(rec.body));
      await archiveOne(deps, parsed);
    } catch (err) {
      // Surfacing the error in logs is fine; SQS will redeliver based on
      // the DLQ policy we configured in CDK.
      console.error('archiver.error', {
        messageId: safeMessageId(rec),
        error: (err as Error).message,
      });
      failures.push({ itemIdentifier: rec.messageId });
    }
  }
  return { batchItemFailures: failures };
}

function safeMessageId(rec: SQSRecord): string | undefined {
  try {
    const parsed = JSON.parse(rec.body);
    return typeof parsed?.message_id === 'string' ? parsed.message_id : undefined;
  } catch {
    return undefined;
  }
}

const s3 = makeS3Client(env.AWS_REGION);
const db = new Db({
  resourceArn: env.DB_CLUSTER_ARN,
  secretArn: env.DB_SECRET_ARN,
  database: env.DB_NAME,
  ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
});

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
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
