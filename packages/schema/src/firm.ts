import { z } from 'zod';
import { FirmId } from './ids.js';

export const RETENTION_YEARS_MIN = 3;
export const RETENTION_YEARS_MAX = 10;

export const FirmConfig = z.object({
  firm_id: FirmId,
  display_name: z.string().min(1).max(256),
  retention_years: z
    .number()
    .int()
    .min(RETENTION_YEARS_MIN, { message: 'SEC 17a-4(b)(4) requires >= 3 years' })
    .max(RETENTION_YEARS_MAX),
  legal_hold_default: z.boolean().default(false),
  primary_region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  replica_region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
  d3p_principal_arn: z.string().startsWith('arn:aws:iam::'),
  saml_metadata_url: z.string().url().optional(),
});
export type FirmConfig = z.infer<typeof FirmConfig>;
