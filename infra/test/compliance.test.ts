import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { FirmStack } from '../lib/firm-stack.js';
import { ReplicaStack } from '../lib/replica-stack.js';
import type { FirmDeployContext } from '../lib/context.js';

const FIRM: FirmDeployContext = {
  firm_id: 'firm_testco1',
  display_name: 'Test Firm',
  retention_years: 7,
  legal_hold_default: false,
  primary_region: 'us-east-1',
  replica_region: 'us-west-2',
  d3p_principal_arn: 'arn:aws:iam::111111111111:role/ExaminerAccess',
  account_id: '222222222222',
};

function synth() {
  const app = new App();
  const stack = new FirmStack(app, 'TestFirmStack', {
    firm: FIRM,
    env: { account: FIRM.account_id, region: FIRM.primary_region },
  });
  return Template.fromStack(stack);
}

function synthWithReplica() {
  const app = new App();
  const replica = new ReplicaStack(app, 'TestReplicaStack', {
    firm: FIRM,
    env: { account: FIRM.account_id, region: FIRM.replica_region },
    crossRegionReferences: true,
  });
  const primary = new FirmStack(app, 'TestFirmStack', {
    firm: FIRM,
    env: { account: FIRM.account_id, region: FIRM.primary_region },
    crossRegionReferences: true,
    replicaTarget: {
      archiveBucketArn: replica.archiveBucket.bucketArn,
      attachmentsBucketArn: replica.attachmentsBucket.bucketArn,
      kmsKeyArn: replica.archiveKey.keyArn,
    },
  });
  primary.addDependency(replica);
  return {
    primary: Template.fromStack(primary),
    replica: Template.fromStack(replica),
  };
}

describe('FirmStack compliance posture', () => {
  it('creates S3 buckets with Object Lock enabled', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
    });
  });

  it('blocks all public access on archive buckets', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('enables versioning on archive buckets (required for Object Lock)', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  it('enforces SSL-only access via bucket policy', () => {
    const template = synth();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  it('creates a KMS key with rotation enabled', () => {
    const template = synth();
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('creates a D3P role assumable only by the configured principal', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { AWS: FIRM.d3p_principal_arn },
          }),
        ]),
      }),
    });
  });

  it('enforces MFA on the Cognito user pool', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
    });
  });

  it('uses a FIFO ingest queue', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SQS::Queue', {
      FifoQueue: true,
    });
  });

  it('enables RDS Data API on the Aurora cluster', () => {
    const template = synth();
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      EnableHttpEndpoint: true,
    });
  });

  it('provisions the seven data/control-plane Lambdas', () => {
    const template = synth();
    // 7 app Lambdas + the framework Lambdas that `cdk.custom_resources.Provider`
    // adds. We assert presence by handler rather than count.
    for (const handler of [
      'ingest.handler',
      'archiver.handler',
      'heartbeat.handler',
      'enroll.handler',
      'authorizer.handler',
      'admin.handler',
      'migrate.handler',
    ]) {
      template.hasResourceProperties('AWS::Lambda::Function', { Handler: handler });
    }
  });

  it('registers a custom resource that triggers the migration runner', () => {
    const template = synth();
    template.resourceCountIs('Custom::ArchiveGLPMigrations', 1);
  });

  it('creates an admin-key Secrets Manager secret bound to the firm', () => {
    const template = synth();
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: Match.stringLikeRegexp('archiveglp/.+/admin-key'),
    });
  });

  it('exposes POST /admin/pending-enrollments as an authenticated-in-code route', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const adminRoute = Object.values(routes).find(
      (r) => (r.Properties as { RouteKey?: string }).RouteKey === 'POST /admin/pending-enrollments',
    );
    expect(adminRoute).toBeDefined();
    // No API Gateway-level authorizer; the Lambda checks the admin key.
    const auth = (adminRoute!.Properties as { AuthorizationType?: string }).AuthorizationType;
    expect(auth ?? 'NONE').toBe('NONE');
  });

  it('attaches a request-type authorizer with no caching to /v1/ingest and /v1/heartbeat', () => {
    const template = synth();
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      AuthorizerResultTtlInSeconds: 0,
      IdentitySource: [
        '$request.header.X-ArchiveGLP-Device',
        '$request.header.X-ArchiveGLP-Timestamp',
        '$request.header.X-ArchiveGLP-Body-Sha256',
        '$request.header.X-ArchiveGLP-Signature',
      ],
    });
  });

  it('leaves /v1/enroll unauthenticated (pairing code is the only bootstrap)', () => {
    const template = synth();
    const routes = template.findResources('AWS::ApiGatewayV2::Route');
    const enrollRoutes = Object.values(routes).filter(
      (r) => (r.Properties as { RouteKey?: string }).RouteKey === 'POST /v1/enroll',
    );
    expect(enrollRoutes.length).toBe(1);
    const enroll = enrollRoutes[0]!.Properties as { AuthorizationType?: string };
    expect(enroll.AuthorizationType ?? 'NONE').toBe('NONE');
  });

  it('wires the archiver as an SQS event source', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });
});

describe('Cross-Region Replication (SEC 17a-4(f)(2)(ii)(D))', () => {
  it('replica stack creates Object-Lock-enabled KMS-encrypted buckets', () => {
    const { replica } = synthWithReplica();
    replica.resourceCountIs('AWS::S3::Bucket', 2);
    replica.allResourcesProperties('AWS::S3::Bucket', {
      ObjectLockEnabled: true,
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  it('replica stack has a KMS key with rotation enabled', () => {
    const { replica } = synthWithReplica();
    replica.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('primary source buckets are configured with replication rules', () => {
    const { primary } = synthWithReplica();
    // Both source buckets (archive + attachments) get replication configs.
    const buckets = primary.findResources('AWS::S3::Bucket', {
      Properties: { ReplicationConfiguration: Match.anyValue() },
    });
    expect(Object.keys(buckets).length).toBe(2);
  });

  it('replication selects KMS-encrypted objects and targets the replica KMS key', () => {
    const { primary } = synthWithReplica();
    primary.hasResourceProperties('AWS::S3::Bucket', {
      ReplicationConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({
            Status: 'Enabled',
            SourceSelectionCriteria: Match.objectLike({
              SseKmsEncryptedObjects: { Status: 'Enabled' },
              ReplicaModifications: { Status: 'Enabled' },
            }),
            Destination: Match.objectLike({
              EncryptionConfiguration: Match.objectLike({
                ReplicaKmsKeyID: Match.anyValue(),
              }),
            }),
          }),
        ]),
      }),
    });
  });

  it('replication role is assumable by the S3 service only', () => {
    const { primary } = synthWithReplica();
    const roles = primary.findResources('AWS::IAM::Role');
    const replicationRole = Object.values(roles).find((r) => {
      const props = r.Properties as {
        AssumeRolePolicyDocument?: { Statement?: { Principal?: { Service?: string } }[] };
      };
      return props.AssumeRolePolicyDocument?.Statement?.some(
        (s) => s.Principal?.Service === 's3.amazonaws.com',
      );
    });
    expect(replicationRole).toBeDefined();
  });
});
