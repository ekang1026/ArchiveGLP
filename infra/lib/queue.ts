import * as cdk from 'aws-cdk-lib';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface QueueProps {
  archiveKey: kms.Key;
}

/**
 * Ingestion queue between the ingest Lambda and the archiver worker.
 * FIFO guarantees per-device order by using employee_id as the message group id.
 */
export class Queue extends Construct {
  public readonly ingestDlq: sqs.Queue;
  public readonly ingestQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props: QueueProps) {
    super(scope, id);

    this.ingestDlq = new sqs.Queue(this, 'IngestDLQ', {
      fifo: true,
      contentBasedDeduplication: true,
      queueName: 'archiveglp-ingest-dlq.fifo',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.archiveKey,
      retentionPeriod: cdk.Duration.days(14),
    });

    this.ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      fifo: true,
      contentBasedDeduplication: true,
      queueName: 'archiveglp-ingest.fifo',
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: props.archiveKey,
      visibilityTimeout: cdk.Duration.minutes(5),
      retentionPeriod: cdk.Duration.days(7),
      deadLetterQueue: {
        queue: this.ingestDlq,
        maxReceiveCount: 5,
      },
    });

    new cdk.CfnOutput(this, 'IngestQueueUrl', { value: this.ingestQueue.queueUrl });
  }
}
