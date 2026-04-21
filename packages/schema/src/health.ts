import { z } from 'zod';
import { DeviceId, EmployeeId, FirmId } from './ids.js';

export const AgentStatus = z.enum([
  'healthy',
  'degraded',
  'tcc_revoked',
  'chatdb_unreadable',
  'offline',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Heartbeat = z.object({
  schema_version: z.literal(1),
  firm_id: FirmId,
  employee_id: EmployeeId,
  device_id: DeviceId,
  agent_version: z.string(),
  os_version: z.string(),
  status: AgentStatus,
  reported_at: z.string().datetime(),
  last_captured_at: z.string().datetime().nullable(),
  queue_depth: z.number().int().nonnegative(),
  clock_skew_ms: z.number().int(),
  // Agent-observed local state. Optional so older agents still pass
  // validation; handler leaves existing DB values untouched when
  // omitted. Paired with server-side ack sync for belt-and-suspenders.
  paused: z.boolean().optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;
