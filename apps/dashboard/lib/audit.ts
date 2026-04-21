import { z } from 'zod';
import { serverConfig, serviceClient } from './supabase';

/**
 * Append-only supervisor-action log (Supabase variant).
 *
 * Mutable Postgres table; S3-Object-Lock-backed WORM archival of audit
 * rows is the tier-2 compliance upgrade, not wired here. See README.
 */

export const AuditActorType = z.enum(['supervisor', 'd3p', 'system']);
export type AuditActorType = z.infer<typeof AuditActorType>;

export const AuditAction = z.enum([
  'page_view',
  'messages_search',
  'message_view',
  'messages_export',
  'device_list_view',
  'command_issued',
  'command_canceled',
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
  const cfg = serverConfig();
  const sb = serviceClient();
  await sb.from('audit_log').insert({
    firm_id: cfg.FIRM_ID,
    actor_type: input.actorType,
    actor_id: input.actorId,
    action: input.action,
    target_type: input.targetType ?? null,
    target_id: input.targetId ?? null,
    metadata: input.metadata ?? {},
  });
}
