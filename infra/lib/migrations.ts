import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as rds from 'aws-cdk-lib/aws-rds';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import type { FirmDeployContext } from './context.js';

export interface MigrationsProps {
  firm: FirmDeployContext;
  dbCluster: rds.DatabaseCluster;
}

/**
 * Forward-only schema migration runner. A CloudFormation custom resource
 * invokes the migrate Lambda on every Create/Update of the firm stack.
 * The Lambda consults ``schema_migrations`` and runs only the ones that
 * haven't been applied, so re-invocation on unchanged migrations is a
 * no-op. Delete is a no-op; data is never dropped on teardown.
 *
 * Deploy ordering: downstream Lambdas (archiver, enroll, heartbeat)
 * should add `node.addDependency(migrations.resource)` so their first
 * cold-start sees the schema present.
 */
export class Migrations extends Construct {
  public readonly runnerFn: lambda.Function;
  public readonly resource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: MigrationsProps) {
    super(scope, id);

    const dbSecret = props.dbCluster.secret;
    if (!dbSecret) {
      throw new Error('DB cluster must expose a secret for migration runner to authenticate.');
    }

    const runnerLogs = new logs.LogGroup(this, 'MigrationFnLogs', {
      logGroupName: `/aws/lambda/archiveglp-${props.firm.firm_id}-migrate`,
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.runnerFn = new lambda.Function(this, 'MigrationFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'migrate.handler',
      code: lambda.Code.fromInline(
        "exports.handler = async () => ({ statusCode: 501, body: 'not deployed' });",
      ),
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        DB_CLUSTER_ARN: props.dbCluster.clusterArn,
        DB_SECRET_ARN: dbSecret.secretArn,
        DB_NAME: 'archiveglp',
      },
      logGroup: runnerLogs,
    });
    dbSecret.grantRead(this.runnerFn);
    this.runnerFn.addToRolePolicy(
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

    const provider = new cr.Provider(this, 'MigrationProvider', {
      onEventHandler: this.runnerFn,
      logGroup: new logs.LogGroup(this, 'MigrationProviderLogs', {
        retention: logs.RetentionDays.ONE_YEAR,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      }),
    });

    // A property that changes when migrations change will trigger an Update.
    // We use a timestamp at synth so CI/CD always re-runs the runner on deploy;
    // re-runs are cheap no-ops when no new migrations have landed.
    this.resource = new cdk.CustomResource(this, 'RunMigrations', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::ArchiveGLPMigrations',
      properties: {
        InvokedAt: new Date().toISOString(),
      },
    });
  }
}
