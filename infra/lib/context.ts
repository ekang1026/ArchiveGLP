import type * as cdk from 'aws-cdk-lib';
import { FirmConfig } from '@archiveglp/schema';
import { z } from 'zod';

const FirmDeployContext = FirmConfig.extend({
  account_id: z.string().regex(/^\d{12}$/),
});
export type FirmDeployContext = z.infer<typeof FirmDeployContext>;

export function loadFirmContext(app: cdk.App): FirmDeployContext {
  const firmId = app.node.tryGetContext('firm');
  if (!firmId) {
    throw new Error(
      'Missing required context: firm. Run with `cdk deploy -c firm=firm_abc123` or set in cdk.context.json under "firms/<id>".',
    );
  }
  const raw = app.node.tryGetContext(`firms/${firmId}`);
  if (!raw) {
    throw new Error(
      `No firm config found at context key firms/${firmId}. Add to cdk.context.json.`,
    );
  }
  return FirmDeployContext.parse(raw);
}
