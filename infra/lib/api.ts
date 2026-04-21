import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwa from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwi from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';
import { lambdaCodeFor } from './lambda-code.js';

export interface ApiProps {
  firm: FirmDeployContext;
  ingestQueue: sqs.Queue;
  archiveKey: kms.Key;
  archiveBucket: s3.Bucket;
  dbCluster: rds.DatabaseCluster;
}

/**
 * HTTP API for agent enroll / ingest / heartbeat, plus the SQS-driven
 * archiver worker.
 *
 * Authentication model:
 *   POST /v1/enroll       unauthenticated, but requires a valid
 *                         one-time pairing_code (admin-issued, in DB).
 *   POST /v1/ingest       signed with the device ECDSA key.
 *   POST /v1/heartbeat    signed with the device ECDSA key.
 *
 * The custom Lambda authorizer verifies signatures against the device's
 * registered public key. Authorizer cache TTL is 0 so replays of a
 * cached allow cannot bypass the 5-minute freshness window.
 */
export class Api extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly ingestFn: lambda.Function;
  public readonly archiverFn: lambda.Function;
  public readonly heartbeatFn: lambda.Function;
  public readonly enrollFn: lambda.Function;
  public readonly authorizerFn: lambda.Function;
  public readonly adminFn: lambda.Function;
  public readonly adminKeySecret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const dbSecret = props.dbCluster.secret;
    if (!dbSecret) {
      throw new Error(
        'Database cluster must expose a secret for Data API auth. Check rds.DatabaseCluster credentials.',
      );
    }

    const dbEnv = {
      DB_CLUSTER_ARN: props.dbCluster.clusterArn,
      DB_SECRET_ARN: dbSecret.secretArn,
      DB_NAME: 'archiveglp',
    };

    // --- Ingest Lambda ---
    const ingestLogs = new logs.LogGroup(this, 'IngestFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-ingest`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.ingestFn = new lambda.Function(this, 'IngestFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCodeFor('ingest'),
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
      handler: 'index.handler',
      code: lambdaCodeFor('archiver'),
      timeout: cdk.Duration.minutes(2),
      memorySize: 1024,
      environment: {
        FIRM_ID: props.firm.firm_id,
        RETENTION_YEARS: String(props.firm.retention_years),
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
        ARCHIVE_KEY_ARN: props.archiveKey.keyArn,
        ...dbEnv,
      },
      logGroup: archiverLogs,
    });
    this.archiverFn.addEventSource(
      new SqsEventSource(props.ingestQueue, {
        batchSize: 10,
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
      handler: 'index.handler',
      code: lambdaCodeFor('heartbeat'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        ...dbEnv,
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

    // --- Enroll Lambda ---
    const enrollLogs = new logs.LogGroup(this, 'EnrollFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-enroll`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.enrollFn = new lambda.Function(this, 'EnrollFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCodeFor('enroll'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        RETENTION_YEARS: String(props.firm.retention_years),
        ARCHIVE_BUCKET: props.archiveBucket.bucketName,
        ARCHIVE_KEY_ARN: props.archiveKey.keyArn,
        ...dbEnv,
      },
      logGroup: enrollLogs,
    });
    props.archiveBucket.grantPut(this.enrollFn);
    props.archiveKey.grantEncrypt(this.enrollFn);
    dbSecret.grantRead(this.enrollFn);
    this.enrollFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
          'rds-data:ExecuteStatement',
        ],
        resources: [props.dbCluster.clusterArn],
      }),
    );

    // --- Authorizer Lambda ---
    const authorizerLogs = new logs.LogGroup(this, 'AuthorizerFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-authorizer`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.authorizerFn = new lambda.Function(this, 'AuthorizerFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCodeFor('authorizer'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        ...dbEnv,
      },
      logGroup: authorizerLogs,
    });
    dbSecret.grantRead(this.authorizerFn);
    this.authorizerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rds-data:ExecuteStatement'],
        resources: [props.dbCluster.clusterArn],
      }),
    );

    // --- Admin key secret + Admin Lambda ---
    this.adminKeySecret = new secretsmanager.Secret(this, 'AdminKeySecret', {
      secretName: `archiveglp/${props.firm.firm_id}/admin-key`,
      description: `Admin API key for ${props.firm.firm_id}. Rotate via Secrets Manager.`,
      generateSecretString: {
        passwordLength: 48,
        excludePunctuation: true,
        includeSpace: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const adminLogs = new logs.LogGroup(this, 'AdminFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-admin`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.adminFn = new lambda.Function(this, 'AdminFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambdaCodeFor('admin'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        RETENTION_YEARS: String(props.firm.retention_years),
        ADMIN_KEY_SECRET_ARN: this.adminKeySecret.secretArn,
        ...dbEnv,
      },
      logGroup: adminLogs,
    });
    this.adminKeySecret.grantRead(this.adminFn);
    dbSecret.grantRead(this.adminFn);
    this.adminFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'rds-data:BeginTransaction',
          'rds-data:CommitTransaction',
          'rds-data:RollbackTransaction',
          'rds-data:ExecuteStatement',
        ],
        resources: [props.dbCluster.clusterArn],
      }),
    );

    const deviceAuthorizer = new apigwa.HttpLambdaAuthorizer(
      'DeviceSignatureAuthorizer',
      this.authorizerFn,
      {
        authorizerName: 'DeviceSignature',
        responseTypes: [apigwa.HttpLambdaResponseType.SIMPLE],
        // IMPORTANT: 0 TTL. Caching an allow would let a replayed
        // request slip past the 5-minute freshness check.
        resultsCacheTtl: cdk.Duration.seconds(0),
        identitySource: [
          '$request.header.X-ArchiveGLP-Device',
          '$request.header.X-ArchiveGLP-Timestamp',
          '$request.header.X-ArchiveGLP-Body-Sha256',
          '$request.header.X-ArchiveGLP-Signature',
        ],
      },
    );

    // --- HTTP API routes ---
    this.httpApi = new apigw.HttpApi(this, 'AgentApi', {
      apiName: `archiveglp-${props.firm.firm_id}-agent-api`,
      disableExecuteApiEndpoint: false,
    });

    // Unauthenticated bootstrap.
    this.httpApi.addRoutes({
      path: '/v1/enroll',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('EnrollIntegration', this.enrollFn),
    });

    // Device-signed routes.
    this.httpApi.addRoutes({
      path: '/v1/ingest',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('IngestIntegration', this.ingestFn),
      authorizer: deviceAuthorizer,
    });
    this.httpApi.addRoutes({
      path: '/v1/heartbeat',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('HeartbeatIntegration', this.heartbeatFn),
      authorizer: deviceAuthorizer,
    });

    // Admin route. Admin-key auth lives inside the Lambda (constant-time
    // header compare against the Secrets Manager value) rather than as a
    // separate authorizer so the key check + DB write sit in one place.
    this.httpApi.addRoutes({
      path: '/admin/pending-enrollments',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('AdminIntegration', this.adminFn),
    });

    new cdk.CfnOutput(this, 'AgentApiUrl', { value: this.httpApi.apiEndpoint });
    new cdk.CfnOutput(this, 'AdminKeySecretArn', { value: this.adminKeySecret.secretArn });
  }
}
