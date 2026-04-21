import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';

export interface DatabaseProps {
  vpc: ec2.IVpc;
  archiveKey: kms.Key;
}

/**
 * Postgres metadata store. NOT the system of record — S3 is. Postgres holds
 * searchable metadata, supervisor review state, and audit rows. Must be
 * rebuildable from S3 in a disaster.
 *
 * IAM authentication is enabled: the ingestion Lambda and archiver assume
 * IAM roles and connect with no static password.
 */
export class Database extends Construct {
  public readonly cluster: rds.DatabaseCluster;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    this.securityGroup = new ec2.SecurityGroup(this, 'DbSG', {
      vpc: props.vpc,
      description: 'ArchiveGLP metadata DB',
      allowAllOutbound: false,
    });

    this.cluster = new rds.DatabaseCluster(this, 'MetadataCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      readers: [rds.ClusterInstance.serverlessV2('reader', { scaleWithWriter: true })],
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.securityGroup],
      iamAuthentication: true,
      storageEncrypted: true,
      storageEncryptionKey: props.archiveKey,
      backup: {
        retention: cdk.Duration.days(35),
        preferredWindow: '03:00-04:00',
      },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      defaultDatabaseName: 'archiveglp',
    });

    new cdk.CfnOutput(this, 'DbEndpoint', { value: this.cluster.clusterEndpoint.hostname });
  }
}
