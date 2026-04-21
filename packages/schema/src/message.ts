import { z } from 'zod';
import { ConversationId, DeviceId, EmployeeId, FirmId, MessageId } from './ids.js';

export const Source = z.enum(['imessage', 'sms']);
export type Source = z.infer<typeof Source>;

export const Direction = z.enum(['inbound', 'outbound']);
export type Direction = z.infer<typeof Direction>;

export const Handle = z.object({
  handle: z.string().min(1).max(256),
  display: z.string().max(256).optional(),
});
export type Handle = z.infer<typeof Handle>;

export const Attachment = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.string().max(128),
  bytes: z.number().int().nonnegative(),
  filename: z.string().max(512).optional(),
  s3_key: z.string().max(1024).optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const BodyEdit = z.object({
  at: z.string().datetime(),
  text: z.string(),
});

/**
 * Canonical captured message. `archive_seq` and `ingested_at` are server-assigned
 * and omitted in the agent-side `ClientMessageEnvelope`.
 */
export const Message = z.object({
  schema_version: z.literal(1),
  firm_id: FirmId,
  employee_id: EmployeeId,
  device_id: DeviceId,
  source: Source,
  conversation_id: ConversationId,
  message_id: MessageId,
  captured_at: z.string().datetime(),
  direction: Direction,
  from: Handle,
  to: z.array(Handle).min(1),
  body_text: z.string().default(''),
  body_edits: z.array(BodyEdit).default([]),
  unsent: z.boolean().default(false),
  attachments: z.array(Attachment).default([]),
  raw_source: z.record(z.unknown()).optional(),
});
export type Message = z.infer<typeof Message>;

export const ClientMessageEnvelope = z.object({
  messages: z.array(Message).min(1).max(500),
  client_batch_id: z.string().uuid(),
  client_sig: z.string(),
});
export type ClientMessageEnvelope = z.infer<typeof ClientMessageEnvelope>;

export const ArchivedMessage = Message.extend({
  archive_seq: z.number().int().positive(),
  ingested_at: z.string().datetime(),
  server_sig: z.string(),
});
export type ArchivedMessage = z.infer<typeof ArchivedMessage>;
