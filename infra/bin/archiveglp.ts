#!/usr/bin/env node
import 'source-map-support/register.js';
import * as cdk from 'aws-cdk-lib';
import { FirmStack } from '../lib/firm-stack.js';
import { ReplicaStack } from '../lib/replica-stack.js';
import { loadFirmContext } from '../lib/context.js';

const app = new cdk.App();

// One CDK invocation targets exactly one firm account but TWO regions:
// the replica region (buckets + KMS key only) and the primary region
// (everything else, plus replication rules pointing at the replica).
// crossRegionReferences=true lets the primary stack consume ARNs from
// the replica stack via SSM-parameter-backed CloudFormation exports.
const firm = loadFirmContext(app);

const replica = new ReplicaStack(app, `ArchiveGLP-${firm.firm_id}-Replica`, {
  firm,
  env: { account: firm.account_id, region: firm.replica_region },
  crossRegionReferences: true,
  description: `ArchiveGLP replica stack for ${firm.display_name} (${firm.firm_id}). 17a-4(f)(2)(ii)(D) duplicate copy.`,
  tags: {
    FirmId: firm.firm_id,
    App: 'ArchiveGLP',
    Compliance: 'SEC-17a-4',
    Role: 'replica',
  },
});

const primary = new FirmStack(app, `ArchiveGLP-${firm.firm_id}`, {
  firm,
  env: { account: firm.account_id, region: firm.primary_region },
  crossRegionReferences: true,
  description: `ArchiveGLP archive stack for ${firm.display_name} (${firm.firm_id}). SEC 17a-4(f) compliant.`,
  tags: {
    FirmId: firm.firm_id,
    App: 'ArchiveGLP',
    Compliance: 'SEC-17a-4',
    Role: 'primary',
  },
  replicaTarget: {
    archiveBucketArn: replica.archiveBucket.bucketArn,
    attachmentsBucketArn: replica.attachmentsBucket.bucketArn,
    kmsKeyArn: replica.archiveKey.keyArn,
  },
});

// Replica region must exist before primary's replication rules reference it.
primary.addDependency(replica);

app.synth();
