import { z } from 'zod';
import { EmployeeId, FirmId } from './ids.js';

/**
 * Admin request to issue a single-use pairing code. The admin API will
 * upsert the firm (retention comes from the env on the Lambda) and
 * employee rows as a side effect so pairing-code issuance is the one
 * place firms bootstrap their roster in the MVP. A dedicated roster-
 * management API comes later.
 */
export const IssuePairingCodeRequest = z.object({
  firm_id: FirmId,
  employee_id: EmployeeId,
  employee_email: z.string().email(),
  employee_full_name: z.string().min(1).max(256),
  expires_in_hours: z.number().int().min(1).max(168).default(24),
});
export type IssuePairingCodeRequest = z.infer<typeof IssuePairingCodeRequest>;

export const IssuePairingCodeResponse = z.object({
  pairing_code: z.string(),
  expires_at: z.string().datetime(),
});
export type IssuePairingCodeResponse = z.infer<typeof IssuePairingCodeResponse>;
