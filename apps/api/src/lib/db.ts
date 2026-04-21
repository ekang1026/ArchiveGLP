import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

export interface DbConfig {
  resourceArn: string;
  secretArn: string;
  database: string;
  region?: string;
}

export type Param = SqlParameter;

/**
 * Thin wrapper over RDS Data API. We use Data API (not pg over VPC) so the
 * Lambdas can stay outside the VPC, keeping cold start fast and IAM auth
 * simple. Aurora Serverless v2 with Data API enabled is required.
 */
export class Db {
  private readonly client: RDSDataClient;
  constructor(private readonly cfg: DbConfig) {
    this.client = new RDSDataClient(cfg.region ? { region: cfg.region } : {});
  }

  async execute(sql: string, parameters: Param[] = []): Promise<ExecuteResult> {
    const res = await this.client.send(
      new ExecuteStatementCommand({
        resourceArn: this.cfg.resourceArn,
        secretArn: this.cfg.secretArn,
        database: this.cfg.database,
        sql,
        parameters,
      }),
    );
    return {
      rows: (res.records ?? []).map(recordToObject),
      numberOfRecordsUpdated: res.numberOfRecordsUpdated ?? 0,
    };
  }

  async withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const begin = await this.client.send(
      new BeginTransactionCommand({
        resourceArn: this.cfg.resourceArn,
        secretArn: this.cfg.secretArn,
        database: this.cfg.database,
      }),
    );
    const transactionId = begin.transactionId;
    if (!transactionId) throw new Error('BeginTransaction did not return a transactionId');
    const tx: Tx = {
      execute: async (sql, parameters = []) => {
        const res = await this.client.send(
          new ExecuteStatementCommand({
            resourceArn: this.cfg.resourceArn,
            secretArn: this.cfg.secretArn,
            database: this.cfg.database,
            sql,
            parameters,
            transactionId,
          }),
        );
        return {
          rows: (res.records ?? []).map(recordToObject),
          numberOfRecordsUpdated: res.numberOfRecordsUpdated ?? 0,
        };
      },
    };
    try {
      const out = await fn(tx);
      await this.client.send(
        new CommitTransactionCommand({
          resourceArn: this.cfg.resourceArn,
          secretArn: this.cfg.secretArn,
          transactionId,
        }),
      );
      return out;
    } catch (err) {
      await this.client
        .send(
          new RollbackTransactionCommand({
            resourceArn: this.cfg.resourceArn,
            secretArn: this.cfg.secretArn,
            transactionId,
          }),
        )
        .catch(() => undefined);
      throw err;
    }
  }
}

export interface Tx {
  execute(sql: string, parameters?: Param[]): Promise<ExecuteResult>;
}

export interface ExecuteResult {
  rows: Record<string, unknown>[];
  numberOfRecordsUpdated: number;
}

/**
 * RDS Data API returns records as a list-of-lists of typed Fields, but without
 * column names. Callers access values positionally via `rows[i]["0"]`, etc.
 */
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
  if ('blobValue' in field) return field.blobValue;
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

export function bool(name: string, value: boolean): Param {
  return { name, value: { booleanValue: value } };
}

export function ts(name: string, value: Date): Param {
  // RDS Data API accepts TIMESTAMP via stringValue with the typeHint.
  return {
    name,
    typeHint: 'TIMESTAMP',
    value: { stringValue: value.toISOString().replace('T', ' ').replace('Z', '') },
  };
}

/**
 * Text array parameter. Data API has no native text[] support, so we pass a
 * Postgres-literal array string and cast in SQL: `:handles::text[]`.
 */
export function textArray(name: string, values: string[]): Param {
  const escaped = values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(',');
  return { name, value: { stringValue: `{${escaped}}` } };
}
