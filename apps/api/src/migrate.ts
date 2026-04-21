import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceResponse,
} from 'aws-lambda';
import { z } from 'zod';
import { Db } from './lib/db.js';
import { applyMigrations, type Migration } from './lib/migrations.js';

// esbuild bundles SQL files as text via --loader:.sql=text.
import init001 from '../../../infra/migrations/001_init.sql';
import pending002 from '../../../infra/migrations/002_pending_enrollment.sql';

const MIGRATIONS: readonly Migration[] = [
  { name: '001_init', sql: init001 },
  { name: '002_pending_enrollment', sql: pending002 },
];

const Env = z.object({
  DB_CLUSTER_ARN: z.string(),
  DB_SECRET_ARN: z.string(),
  DB_NAME: z.string().default('archiveglp'),
  AWS_REGION: z.string().optional(),
});
const env = Env.parse(process.env);

/**
 * CloudFormation custom resource handler. Runs on Create and Update events.
 * Delete is a no-op: Object Lock + RETAIN policies mean we do not drop data
 * on stack deletion, and unwinding a schema on Delete would be destructive.
 */
export const handler = async (
  event: CloudFormationCustomResourceEvent,
): Promise<CloudFormationCustomResourceResponse> => {
  const physicalId =
    'PhysicalResourceId' in event && typeof event.PhysicalResourceId === 'string'
      ? event.PhysicalResourceId
      : 'archiveglp-migrations';

  const base = {
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    PhysicalResourceId: physicalId,
  };

  if (event.RequestType === 'Delete') {
    return { ...base, Status: 'SUCCESS' };
  }

  try {
    const db = new Db({
      resourceArn: env.DB_CLUSTER_ARN,
      secretArn: env.DB_SECRET_ARN,
      database: env.DB_NAME,
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    });
    const result = await applyMigrations(db, MIGRATIONS);
    console.log('migrations.applied', result);
    return {
      ...base,
      Status: 'SUCCESS',
      Data: {
        AppliedNow: result.appliedNow.join(','),
        AlreadyApplied: result.alreadyApplied.join(','),
      },
    };
  } catch (err) {
    console.error('migrations.failed', (err as Error).message);
    return {
      ...base,
      Status: 'FAILED',
      Reason: (err as Error).message.slice(0, 300),
    };
  }
};
