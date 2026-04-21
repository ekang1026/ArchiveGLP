import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { FirmStack } from '../lib/firm-stack.js';
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

  it('provisions ingest, archiver, and heartbeat Lambdas', () => {
    const template = synth();
    template.resourceCountIs('AWS::Lambda::Function', 3);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'archiver.handler',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'heartbeat.handler',
    });
  });

  it('wires the archiver as an SQS event source', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });
});
