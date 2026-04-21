import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface ReplicaStackProps extends cdk.StackProps {
  firm: FirmDeployContext;
}

/**
 * Deploys the replica-region half of the firm's archive: a regional KMS
 * CMK and two Object-Lock-enabled buckets that the primary region's S3
 * replication rules target.
 *
 * SEC 17a-4(f)(2)(ii)(D) duplicate copy is satisfied by replicating every
 * archive object to this bucket. Object Lock retain-until-date and legal
 * hold flags are replicated automatically as long as the destination
 * bucket has Object Lock enabled - which it does here. Compliance mode,
 * not Governance: retention dates cannot be shortened on the replica
 * any more than on the source.
 *
 * KMS keys are regional, so the replica gets its own CMK. The primary
 * stack's replication role is granted Encrypt on this key's ARN with an
 * aws:s3:arn encryption-context condition scoped to the replica buckets.
 */
export class ReplicaStack extends cdk.Stack {
  public readonly archiveKey: kms.Key;
  public readonly archiveBucket: s3.Bucket;
  public readonly attachmentsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: ReplicaStackProps) {
    super(scope, id, props);

    const { firm } = props;
    const firmSlug = firm.firm_id.replaceAll('_', '-');

    this.archiveKey = new kms.Key(this, 'ReplicaArchiveKey', {
      description: `ArchiveGLP replica CMK for ${firm.firm_id}`,
      enableKeyRotation: true,
      alias: `alias/archiveglp/${firm.firm_id}/replica`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Allow the firm account's root to administer the key. The replication
    // role in the primary stack will be granted encrypt via its own IAM
    // policy (not a key-policy grant here) so a teardown of the primary
    // stack doesn't leave orphan key-policy statements.
    this.archiveKey.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.AccountPrincipal(firm.account_id)],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
        resources: ['*'],
      }),
    );

    this.archiveBucket = this.createLockedBucket('ReplicaArchiveBucket', {
      bucketName: `archiveglp-${firmSlug}-archive-${firm.replica_region}`,
    });
    this.attachmentsBucket = this.createLockedBucket('ReplicaAttachmentsBucket', {
      bucketName: `archiveglp-${firmSlug}-attach-${firm.replica_region}`,
    });

    new cdk.CfnOutput(this, 'ReplicaArchiveBucketName', {
      value: this.archiveBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'ReplicaAttachmentsBucketName', {
      value: this.attachmentsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'ReplicaArchiveKeyArn', { value: this.archiveKey.keyArn });
  }

  private createLockedBucket(logicalId: string, opts: { bucketName: string }): s3.Bucket {
    return new s3.Bucket(this, logicalId, {
      bucketName: opts.bucketName,
      versioned: true,
      objectLockEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.archiveKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'transition-to-glacier-ir',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(180),
            },
          ],
        },
      ],
    });
  }
}
