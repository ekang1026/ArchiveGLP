import {
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { serverEnv } from './env';

/**
 * Scoped duplicate of apps/api/src/lib/db.ts. Consolidate into
 * packages/dbclient after this slice lands - separate package is a
 * larger refactor than the dashboard slice warrants.
 */

export type Param = SqlParameter;

let cachedClient: RDSDataClient | null = null;

function client(region?: string): RDSDataClient {
  if (cachedClient) return cachedClient;
  cachedClient = new RDSDataClient(region ? { region } : {});
  return cachedClient;
}

export interface ExecuteResult {
  rows: Record<string, unknown>[];
  numberOfRecordsUpdated: number;
}

export async function execute(sql: string, parameters: Param[] = []): Promise<ExecuteResult> {
  const env = serverEnv();
  const res = await client(env.AWS_REGION).send(
    new ExecuteStatementCommand({
      resourceArn: env.DB_CLUSTER_ARN,
      secretArn: env.DB_SECRET_ARN,
      database: env.DB_NAME,
      sql,
      parameters,
    }),
  );
  return {
    rows: (res.records ?? []).map(recordToObject),
    numberOfRecordsUpdated: res.numberOfRecordsUpdated ?? 0,
  };
}

function recordToObject(record: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  record.forEach((field, idx) => {
    out[String(idx)] = fieldValue(field);
  });
  return out;
}

function fieldValue(field: Field): unknown {
  if ('isNull' in field) return null;
  if ('stringValue' in field) return field.stringValue;
  if ('longValue' in field) return field.longValue;
  if ('doubleValue' in field) return field.doubleValue;
  if ('booleanValue' in field) return field.booleanValue;
  return null;
}

export function str(name: string, value: string | null): Param {
  return value === null
    ? { name, value: { isNull: true } }
    : { name, value: { stringValue: value } };
}

export function num(name: string, value: number | bigint | null): Param {
  return value === null
    ? { name, value: { isNull: true } }
    : { name, value: { longValue: Number(value) } };
}

export function ts(name: string, value: Date | null): Param {
  if (value === null) return { name, value: { isNull: true } };
  return {
    name,
    typeHint: 'TIMESTAMP',
    value: { stringValue: value.toISOString().replace('T', ' ').replace('Z', '') },
  };
}

export function json(name: string, value: unknown): Param {
  return {
    name,
    typeHint: 'JSON',
    value: { stringValue: JSON.stringify(value) },
  };
}
