import crypto from 'node:crypto';
import { ClientMessageEnvelope } from '@archiveglp/schema';
import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Context,
} from 'aws-lambda';
import { z } from 'zod';

const Env = z.object({
  FIRM_ID: z.string(),
  INGEST_QUEUE_URL: z.string().url(),
  AWS_REGION: z.string().optional(),
});

const env = Env.parse(process.env);

const sqs = new SQSClient(env.AWS_REGION ? { region: env.AWS_REGION } : {});

type Json = Record<string, unknown>;

export interface IngestDeps {
  send: (payloads: Json[], groupId: string) => Promise<void>;
  now: () => Date;
}

/**
 * Validates, enriches, and enqueues a batch of captured messages.
 *
 * - Rejects envelopes whose firm_id does not match the tenant-bound env.
 * - Assigns server `ingested_at` so downstream ordering uses server time.
 * - Uses `employee_id` as the FIFO group id so per-employee order is preserved
 *   across concurrent workers.
 * - Does NOT assign `archive_seq` here; that happens in the archiver worker
 *   which holds a per-firm monotonic counter in DynamoDB or Postgres.
 */
export async function handle(
  event: APIGatewayProxyEventV2,
  deps: IngestDeps,
): Promise<APIGatewayProxyResultV2> {
  if (!event.body) {
    return json(400, { error: 'empty body' });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(event.body);
  } catch {
    return json(400, { error: 'invalid json' });
  }

  const parsed = ClientMessageEnvelope.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: 'schema', details: parsed.error.flatten() });
  }
  const envelope = parsed.data;

  // Tenancy guard: the API lives in a firm-specific AWS account; the env's
  // FIRM_ID is authoritative. Any agent claiming a different firm is rejected.
  const mismatched = envelope.messages.filter((m) => m.firm_id !== env.FIRM_ID);
  if (mismatched.length > 0) {
    return json(403, { error: 'firm_id mismatch' });
  }

  // Group by employee_id so we can submit in-order per employee.
  const byEmployee = new Map<string, Json[]>();
  const ingestedAt = deps.now().toISOString();

  for (const m of envelope.messages) {
    const enriched = { ...m, ingested_at: ingestedAt };
    const list = byEmployee.get(m.employee_id) ?? [];
    list.push(enriched);
    byEmployee.set(m.employee_id, list);
  }

  for (const [employeeId, list] of byEmployee) {
    await deps.send(list, employeeId);
  }

  return json(202, {
    accepted: envelope.messages.length,
    batch_id: envelope.client_batch_id,
  });
}

async function sendToSqs(payloads: Json[], groupId: string): Promise<void> {
  // SQS SendMessageBatch max 10 per call, max 256KB each and 256KB total.
  // For MVP we send one message per captured event; batching by chat_id is a v2.
  for (let i = 0; i < payloads.length; i += 10) {
    const slice = payloads.slice(i, i + 10);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: env.INGEST_QUEUE_URL,
        Entries: slice.map((p, idx) => ({
          Id: `${groupId}-${i + idx}`,
          MessageBody: JSON.stringify(p),
          MessageGroupId: groupId,
          MessageDeduplicationId: crypto
            .createHash('sha256')
            .update(JSON.stringify(p))
            .digest('hex'),
        })),
      }),
    );
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  _context: Context,
): Promise<APIGatewayProxyResultV2> => {
  return handle(event, { send: sendToSqs, now: () => new Date() });
};
