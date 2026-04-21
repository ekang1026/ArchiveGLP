import { z } from 'zod';
import { DeviceId, EmployeeId, FirmId } from './ids.js';

/**
 * Attestation captured at first-run. Archived as its own record so the firm
 * (and regulators) can demonstrate informed consent.
 */
export const EnrollmentAttestation = z.object({
  schema_version: z.literal(1),
  firm_id: FirmId,
  employee_id: EmployeeId,
  device_id: DeviceId,
  employee_full_name_typed: z.string().min(1).max(256),
  employee_email: z.string().email(),
  disclosures_version: z.string(),
  disclosures_shown: z.array(z.string()),
  attested_at: z.string().datetime(),
  device_public_key_spki_b64: z.string(),
  os_version: z.string(),
  agent_version: z.string(),
});
export type EnrollmentAttestation = z.infer<typeof EnrollmentAttestation>;

/**
 * Request body for POST /v1/enroll. The pairing_code is a single-use token
 * issued by a firm admin (via the admin API - currently insertable by SQL
 * until that API lands) and scoped to a specific firm_id + employee_email.
 *
 * Pairing codes are the reason /v1/enroll can be unauthenticated: possession
 * of the code is what authorizes creation of the device row. Signed-request
 * auth takes over from the next request onward.
 */
export const EnrollmentRequest = z.object({
  pairing_code: z.string().min(16).max(128),
  attestation: EnrollmentAttestation,
});
export type EnrollmentRequest = z.infer<typeof EnrollmentRequest>;

export const PAIRING_CODE_MIN_ENTROPY_BITS = 128;

