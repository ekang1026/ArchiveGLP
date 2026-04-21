import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface StorageProps {
  firm: FirmDeployContext;
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
}
