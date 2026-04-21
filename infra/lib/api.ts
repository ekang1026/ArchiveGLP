import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwi from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface ApiProps {
  firm: FirmDeployContext;
  ingestQueue: sqs.Queue;
  archiveKey: kms.Key;
  archiveBucket: s3.Bucket;
  dbCluster: rds.DatabaseCluster;
}

/**
 * HTTP API for agent ingest + heartbeat, plus the SQS-driven archiver worker.
 *
 * Authentication is bespoke: the agent signs every request with a Secure
 * Enclave keypair registered at enrollment. A Lambda authorizer verifies
 * signatures against the device public key stored in Postgres.
 *
 * We intentionally do NOT use API Gateway IAM auth or Cognito here; agents
 * are headless and never hold AWS credentials.
 */
export class Api extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly ingestFn: lambda.Function;
  public readonly archiverFn: lambda.Function;
  public readonly heartbeatFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const dbSecret = props.dbCluster.secret;
    if (!dbSecret) {
      throw new Error(
        'Database cluster must expose a secret for Data API auth. Check rds.DatabaseCluster credentials.',
      );
    }

    const placeholderCode = lambda.Code.fromInline(
      "exports.handler = async () => ({ statusCode: 501, body: 'not deployed' });",
    );

    // --- Ingest Lambda ---
    const ingestLogs = new logs.LogGroup(this, 'IngestFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-ingest`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.ingestFn = new lambda.Function(this, 'IngestFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'ingest.handler',
      code: placeholderCode,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        INGEST_QUEUE_URL: props.ingestQueue.queueUrl,
        ARCHIVE_KEY_ARN: props.archiveKey.keyArn,
      },
      logGroup: ingestLogs,
    });
    props.ingestQueue.grantSendMessages(this.ingestFn);
    props.archiveKey.grantEncrypt(this.ingestFn);

    // --- Archiver Lambda (SQS-driven) ---
    const archiverLogs = new logs.LogGroup(this, 'ArchiverFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-archiver`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.archiverFn = new lambda.Function(this, 'ArchiverFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'archiver.handler',
      code: placeholderCode,
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      environment: {
        FIRM_ID: props.firm.firm_id,
        RETENTION_YEARS: String(props.firm.retention_years),
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
        ARCHIVE_KEY_ARN: props.archiveKey.keyArn,
        DB_CLUSTER_ARN: props.dbCluster.clusterArn,
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_NAME: 'archiveglp',
      },
      logGroup: archiverLogs,
    });
    this.archiverFn.addEventSource(
      new SqsEventSource(props.ingestQueue, {
        batchSize: 10,
        // FIFO queues do not support maxBatchingWindow.
        reportBatchItemFailures: true,
      }),
    );
    props.archiveBucket.grantPut(this.archiverFn);
    props.archiveKey.grantEncrypt(this.archiverFn);
    dbSecret.grantRead(this.archiverFn);
    this.archiverFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
          'rds-data:ExecuteStatement',
          'rds-data:BatchExecuteStatement',
        ],
        resources: [props.dbCluster.clusterArn],
      }),
    );

    // --- Heartbeat Lambda ---
    const heartbeatLogs = new logs.LogGroup(this, 'HeartbeatFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-heartbeat`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.heartbeatFn = new lambda.Function(this, 'HeartbeatFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'heartbeat.handler',
      code: placeholderCode,
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        DB_CLUSTER_ARN: props.dbCluster.clusterArn,
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_NAME: 'archiveglp',
      },
      logGroup: heartbeatLogs,
    });
    dbSecret.grantRead(this.heartbeatFn);
    this.heartbeatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds-data:ExecuteStatement'],
        resources: [props.dbCluster.clusterArn],
      }),
    );

    // --- HTTP API routes ---
    this.httpApi = new apigw.HttpApi(this, 'AgentApi', {
      apiName: `archiveglp-${props.firm.firm_id}-agent-api`,
      disableExecuteApiEndpoint: false,
    });
    this.httpApi.addRoutes({
      path: '/v1/ingest',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('IngestIntegration', this.ingestFn),
    });
    this.httpApi.addRoutes({
      path: '/v1/heartbeat',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('HeartbeatIntegration', this.heartbeatFn),
    });

    new cdk.CfnOutput(this, 'AgentApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
