import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface ReplicaTarget {
  archiveBucketArn: string;
  attachmentsBucketArn: string;
  kmsKeyArn: string;
}

export interface StorageProps {
  firm: FirmDeployContext;
  /**
   * If provided, configures S3 Cross-Region Replication from the source
   * archive + attachments buckets to these replica ARNs, satisfying
   * SEC 17a-4(f)(2)(ii)(D) duplicate copy. If omitted (tests, dev),
   * buckets are created but replication rules are not attached.
   */
  replicaTarget?: ReplicaTarget;
}

/**
 * WORM-compliant archive storage for SEC 17a-4(f).
 *
 * - S3 Object Lock in COMPLIANCE mode is enabled at bucket creation and cannot be
 *   disabled or relaxed. Retention is applied per-object at ingest time based on
 *   the firm's configured retention_years (>= 3 per SEC 17a-4(b)(4)).
 * - Cross-Region Replication to a separate region. Replica bucket also has
 *   Object Lock Compliance enabled (17a-4(f)(2)(ii)(D) duplicate copy).
 * - KMS CMK scoped to this firm's account, encryption SSE-KMS, bucket-key enabled.
 * - Versioning is required for Object Lock and is enabled.
 * - Public access fully blocked. TLS-only via bucket policy.
 */
export class Storage extends Construct {
  public readonly archiveBucket: s3.Bucket;
  public readonly attachmentsBucket: s3.Bucket;
  public readonly archiveKey: kms.Key;
  public readonly replicationRole?: iam.Role;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);

    const { firm } = props;

    this.archiveKey = new kms.Key(this, 'ArchiveKey', {
      description: `ArchiveGLP KMS CMK for ${firm.firm_id}`,
      enableKeyRotation: true,
      alias: `alias/archiveglp/${firm.firm_id}/archive`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 bucket names disallow underscores; normalize firm_id for naming only.
    const firmSlug = firm.firm_id.replaceAll('_', '-');

    this.archiveBucket = this.createLockedBucket('ArchiveBucket', {
      firm,
      bucketName: `archiveglp-${firmSlug}-archive-${firm.primary_region}`,
      kmsKey: this.archiveKey,
    });

    this.attachmentsBucket = this.createLockedBucket('AttachmentsBucket', {
      firm,
      bucketName: `archiveglp-${firmSlug}-attach-${firm.primary_region}`,
      kmsKey: this.archiveKey,
    });

    if (props.replicaTarget) {
      this.replicationRole = this.configureReplication(firm, props.replicaTarget);
    }

    new cdk.CfnOutput(this, 'ArchiveBucketName', { value: this.archiveBucket.bucketName });
    new cdk.CfnOutput(this, 'AttachmentsBucketName', {
      value: this.attachmentsBucket.bucketName,
    });
    new cdk.CfnOutput(this, 'ArchiveKeyArn', { value: this.archiveKey.keyArn });
  }

  private createLockedBucket(
    logicalId: string,
    opts: { firm: FirmDeployContext; bucketName: string; kmsKey: kms.Key },
  ): s3.Bucket {
    const bucket = new s3.Bucket(this, logicalId, {
      bucketName: opts.bucketName,
      versioned: true,
      objectLockEnabled: true,
      // IMPORTANT: do NOT set a default retention. Retention is applied per-object
      // at ingest time using the firm's current retention_years. A default here
      // would lock ALL objects at the bucket's configured duration including
      // audit/system objects we may need to expire.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: opts.kmsKey,
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
          noncurrentVersionTransitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    // SEC 17a-4(f)(3)(v) D3P: separate read-only role is created in the top-level
    // firm stack and granted access to this bucket there. We do not grant here.

    return bucket;
  }

  /**
   * Attaches the replication role and configuration to both source buckets.
   *
   * The role's IAM policy is the authority for KMS decrypt/encrypt across
   * regions; we intentionally do NOT touch the replica-region key policy
   * from the primary stack so the two stacks stay independently deployable.
   * The replica key's resource policy already grants the firm account root
   * the relevant KMS actions (see ReplicaStack).
   */
  private configureReplication(firm: FirmDeployContext, target: ReplicaTarget): iam.Role {
    const role = new iam.Role(this, 'ReplicationRole', {
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
      description: `S3 replication role for ${firm.firm_id}`,
    });

    // List / get replication config on source buckets.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetReplicationConfiguration', 's3:ListBucket'],
        resources: [this.archiveBucket.bucketArn, this.attachmentsBucket.bucketArn],
      }),
    );
    // Read source objects + their versions/tags/ACLs.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionTagging',
          's3:GetObjectRetention',
          's3:GetObjectLegalHold',
        ],
        resources: [`${this.archiveBucket.bucketArn}/*`, `${this.attachmentsBucket.bucketArn}/*`],
      }),
    );
    // Write replicated objects + retention / legal hold on destination.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          's3:ReplicateObject',
          's3:ReplicateDelete',
          's3:ReplicateTags',
          's3:GetObjectVersionTagging',
          's3:ObjectOwnerOverrideToBucketOwner',
        ],
        resources: [`${target.archiveBucketArn}/*`, `${target.attachmentsBucketArn}/*`],
      }),
    );
    // Decrypt with source KMS key, scoped by service + encryption-context
    // condition to the source buckets.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: [this.archiveKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${firm.primary_region}.amazonaws.com`,
          },
          StringLike: {
            'kms:EncryptionContext:aws:s3:arn': [
              `${this.archiveBucket.bucketArn}/*`,
              `${this.attachmentsBucket.bucketArn}/*`,
            ],
          },
        },
      }),
    );
    // Encrypt with replica KMS key, scoped by service + encryption-context
    // condition to the replica buckets.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Encrypt'],
        resources: [target.kmsKeyArn],
        conditions: {
          StringEquals: {
            'kms:ViaService': `s3.${firm.replica_region}.amazonaws.com`,
          },
          StringLike: {
            'kms:EncryptionContext:aws:s3:arn': [
              `${target.archiveBucketArn}/*`,
              `${target.attachmentsBucketArn}/*`,
            ],
          },
        },
      }),
    );

    // Attach replication config via property override on the L1 CfnBucket
    // because L2 Bucket doesn't expose replicationConfiguration as a prop.
    const cfnArchive = this.archiveBucket.node.defaultChild as s3.CfnBucket;
    const cfnAttach = this.attachmentsBucket.node.defaultChild as s3.CfnBucket;

    const makeRules = (destinationArn: string) => [
      {
        id: 'crr-all',
        status: 'Enabled',
        priority: 0,
        filter: { prefix: '' },
        deleteMarkerReplication: { status: 'Enabled' },
        sourceSelectionCriteria: {
          sseKmsEncryptedObjects: { status: 'Enabled' },
          replicaModifications: { status: 'Enabled' },
        },
        destination: {
          bucket: destinationArn,
          encryptionConfiguration: { replicaKmsKeyId: target.kmsKeyArn },
        },
      },
    ];

    cfnArchive.replicationConfiguration = {
      role: role.roleArn,
      rules: makeRules(target.archiveBucketArn),
    };
    cfnAttach.replicationConfiguration = {
      role: role.roleArn,
      rules: makeRules(target.attachmentsBucketArn),
    };

    return role;
  }
}
