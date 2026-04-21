import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwi from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface ApiProps {
  firm: FirmDeployContext;
  ingestQueue: sqs.Queue;
  archiveKey: kms.Key;
}

/**
 * HTTP API for agent ingest + heartbeat + enrollment.
 *
 * Authentication is bespoke: the agent signs every request with a Secure
 * Enclave keypair registered at enrollment. A Lambda authorizer verifies
 * signatures against the device public key stored in DynamoDB.
 *
 * We intentionally do NOT use API Gateway IAM auth or Cognito here; agents
 * are headless and never hold AWS credentials.
 */
export class Api extends Construct {
  public readonly httpApi: apigw.HttpApi;
  public readonly ingestFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);

    const ingestLogGroup = new logs.LogGroup(this, 'IngestFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-ingest`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.ingestFn = new lambda.Function(this, 'IngestFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'ingest.handler',
      // Placeholder: the actual bundle is produced from apps/api at deploy time.
      // For `cdk synth` in CI and in tests we use an inline stub.
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 501, body: 'not deployed' });",
      ),
      timeout: cdk.Duration.seconds(10),
      memorySize: 512,
      environment: {
        FIRM_ID: props.firm.firm_id,
        INGEST_QUEUE_URL: props.ingestQueue.queueUrl,
        ARCHIVE_KEY_ARN: props.archiveKey.keyArn,
      },
      logGroup: ingestLogGroup,
    });

    props.ingestQueue.grantSendMessages(this.ingestFn);
    props.archiveKey.grantEncrypt(this.ingestFn);
    this.ingestFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['kms:Sign'],
        resources: [props.archiveKey.keyArn],
      }),
    );

    this.httpApi = new apigw.HttpApi(this, 'AgentApi', {
      apiName: `archiveglp-${props.firm.firm_id}-agent-api`,
      disableExecuteApiEndpoint: false,
    });

    this.httpApi.addRoutes({
      path: '/v1/ingest',
      methods: [apigw.HttpMethod.POST],
      integration: new apigwi.HttpLambdaIntegration('IngestIntegration', this.ingestFn),
    });

    // Heartbeat + enrollment routes added later with their own handlers.

    new cdk.CfnOutput(this, 'AgentApiUrl', { value: this.httpApi.apiEndpoint });
  }
}
