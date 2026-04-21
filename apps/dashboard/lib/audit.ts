import { z } from 'zod';
import { execute, json, str } from './db';
import { serverEnv } from './env';

/**
 * Append-only supervisor-action log.
 *
 * Every search, message view, and export performed by a supervisor on
 * this dashboard writes a row here. Supervisors cannot write directly;
 * callers use recordAudit() after auth verification.
 *
 * NOTE: For full SEC 17a-4(f) compliance the audit rows ALSO need to
 * land in S3 Object Lock. That's a separate downstream job (read new
 * rows, archive, mark `s3_bucket/s3_key`); this function only writes
 * the Postgres row. The rows are never updated or deleted - same
 * retention posture, weaker durability guarantees until the S3 step
 * is added.
 */

export const AuditActorType = z.enum(['supervisor', 'd3p', 'system']);
export type AuditActorType = z.infer<typeof AuditActorType>;

export const AuditAction = z.enum([
  'page_view',
  'messages_search',
  'message_view',
  'messages_export',
  'device_list_view',
  'login',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export interface RecordAuditInput {
  actorType: AuditActorType;
  actorId: string;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(input: RecordAuditInput): Promise<void> {
  const env = serverEnv();
  await execute(
    `INSERT INTO audit_log (
       firm_id, actor_type, actor_id, action, target_type, target_id, metadata
     ) VALUES (
       :firm_id, :actor_type, :actor_id, :action, :target_type, :target_id, :metadata::jsonb
     )`,
    [
      str('firm_id', env.FIRM_ID),
      str('actor_type', input.actorType),
      str('actor_id', input.actorId),
      str('action', input.action),
      str('target_type', input.targetType ?? null),
      str('target_id', input.targetId ?? null),
      json('metadata', input.metadata ?? {}),
    ],
  );
}
