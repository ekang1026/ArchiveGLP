import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { Api } from './api.js';
import type { FirmDeployContext } from './context.js';
import { Database } from './db.js';
import { Auth } from './auth.js';
import { Migrations } from './migrations.js';
import { Queue } from './queue.js';
import { Storage, type ReplicaTarget } from './storage.js';

export interface FirmStackProps extends cdk.StackProps {
  firm: FirmDeployContext;
  /**
   * Replica-region bucket + KMS key ARNs produced by the ReplicaStack
   * in firm.replica_region. Optional for tests that synth only the
   * primary stack.
   */
  replicaTarget?: ReplicaTarget;
}

/**
 * Deploys one firm's complete archive stack in the firm's dedicated AWS account.
 */
export class FirmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FirmStackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
    });

    const storage = new Storage(this, 'Storage', {
      firm: props.firm,
      ...(props.replicaTarget ? { replicaTarget: props.replicaTarget } : {}),
    });
    const queue = new Queue(this, 'Queue', { archiveKey: storage.archiveKey });
    const db = new Database(this, 'Db', { vpc, archiveKey: storage.archiveKey });
    new Auth(this, 'Auth', { firm: props.firm });

    const migrations = new Migrations(this, 'Migrations', {
      firm: props.firm,
      dbCluster: db.cluster,
    });

    const api = new Api(this, 'Api', {
      firm: props.firm,
      ingestQueue: queue.ingestQueue,
      archiveKey: storage.archiveKey,
      archiveBucket: storage.archiveBucket,
      dbCluster: db.cluster,
    });

    // Data-plane Lambdas depend on migrations having been applied.
    // Without this ordering a cold start could happen before the schema
    // exists.
    for (const fn of [api.archiverFn, api.enrollFn, api.heartbeatFn, api.adminFn]) {
      fn.node.addDependency(migrations.resource);
    }

    // SEC 17a-4(f)(3)(v) Designated Third Party: a read-only role assumable
    // only by the firm's named D3P principal. Granted read on the archive
    // and attachments buckets and decrypt on the KMS CMK.
    const d3p = new iam.Role(this, 'D3PRole', {
      roleName: `ArchiveGLP-${props.firm.firm_id}-D3P`,
      assumedBy: new iam.ArnPrincipal(props.firm.d3p_principal_arn),
      description: 'SEC 17a-4(f)(3)(v) Designated Third Party read-only access.',
      maxSessionDuration: cdk.Duration.hours(4),
    });
    storage.archiveBucket.grantRead(d3p);
    storage.attachmentsBucket.grantRead(d3p);
    storage.archiveKey.grantDecrypt(d3p);

    new cdk.CfnOutput(this, 'D3PRoleArn', { value: d3p.roleArn });
  }
}
