#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { FirmStack } from '../lib/firm-stack.js';
import { loadFirmContext } from '../lib/context.js';

const app = new cdk.App();

// One CDK invocation targets exactly one firm account. Firm config is
// loaded from cdk.context.json or -c firm=<id> at deploy time.
const firm = loadFirmContext(app);

new FirmStack(app, `ArchiveGLP-${firm.firm_id}`, {
  firm,
  env: {
    account: firm.account_id,
    region: firm.primary_region,
  },
  crossRegionReferences: true,
  description: `ArchiveGLP archive stack for ${firm.display_name} (${firm.firm_id}). SEC 17a-4(f) compliant.`,
  tags: {
    FirmId: firm.firm_id,
    App: 'ArchiveGLP',
    Compliance: 'SEC-17a-4',
  },
});

app.synth();
