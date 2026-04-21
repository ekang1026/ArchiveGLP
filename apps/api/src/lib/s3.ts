import { ObjectLockMode, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ArchivePutOptions {
  bucket: string;
  key: string;
  body: Uint8Array | string;
  retainUntil: Date;
  kmsKeyId: string;
  contentType?: string;
  metadata?: Record<string, string>;
}

/**
 * Put an object to S3 with Object Lock in COMPLIANCE mode, KMS-encrypted.
 *
 * Compliance mode means the retention date cannot be shortened by anyone,
 * including the root account. This is what SEC 17a-4(f)(2)(ii)(A) requires
 * and what separates this from Governance mode (which privileged users can
 * override). DO NOT change the mode.
 */
export async function putArchive(s3: S3Client, opts: ArchivePutOptions): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType ?? 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: opts.kmsKeyId,
      ObjectLockMode: ObjectLockMode.COMPLIANCE,
      ObjectLockRetainUntilDate: opts.retainUntil,
      Metadata: opts.metadata,
    }),
  );
}

export function makeS3Client(region?: string): S3Client {
  return new S3Client(region ? { region } : {});
}
