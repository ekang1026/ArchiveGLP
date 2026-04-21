import type { SQSEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub env before importing the module under test.
process.env.FIRM_ID = 'firm_testco1';
process.env.RETENTION_YEARS = '7';
process.env.ARCHIVE_BUCKET = 'archiveglp-firm-testco1-archive-us-east-1';
process.env.ARCHIVE_KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/abc';
process.env.DB_CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:c';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s';
process.env.DB_NAME = 'archiveglp';

const { archiveOne, handle } = await import('./archiver.js');

type IngestedMessageFixture = Parameters<typeof archiveOne>[1];

function ingested(overrides: Record<string, unknown> = {}): IngestedMessageFixture {
  return {
    schema_version: 1,
    firm_id: 'firm_testco1',
    employee_id: 'emp_jane42xx',
    device_id: 'dev_macbook01',
    source: 'imessage',
    conversation_id: 'chat:+15551234567',
    message_id: 'imsg:guid=ABC',
    captured_at: '2026-04-21T18:04:12.221Z',
    ingested_at: '2026-04-21T18:04:13.000Z',
    direction: 'inbound',
    from: { handle: '+15551234567' },
    to: [{ handle: 'jane@example.com' }],
    body_text: 'hi',
    body_edits: [],
    unsent: false,
    attachments: [],
    ...overrides,
  } as IngestedMessageFixture;
}

function makeDeps() {
  const s3Send = vi.fn().mockResolvedValue({});
  const s3 = { send: s3Send } as unknown as import('@aws-sdk/client-s3').S3Client;

  let seq = 0;
  const txExecute = vi.fn(async (sql: string) => {
    if (sql.includes("nextval('archive_seq')")) {
      seq += 1;
      return { rows: [{ '0': seq }], numberOfRecordsUpdated: 0 };
    }
    if (sql.trimStart().toUpperCase().startsWith('INSERT INTO MESSAGE_META')) {
      return { rows: [], numberOfRecordsUpdated: 1 };
    }
    return { rows: [], numberOfRecordsUpdated: 1 };
  });
  const withTx = vi.fn(async (fn: (tx: { execute: typeof txExecute }) => Promise<unknown>) => {
    return fn({ execute: txExecute });
  });
  const db = { withTx } as unknown as import('./lib/db.js').Db;

  return {
    s3,
    s3Send,
    db,
    withTx,
    txExecute,
    now: () => new Date('2026-04-21T18:04:14.000Z'),
    firmId: 'firm_testco1',
    retentionYears: 7,
    bucket: 'archiveglp-firm-testco1-archive-us-east-1',
    kmsKeyId: 'arn:aws:kms:us-east-1:111111111111:key/abc',
  };
}

describe('archiveOne', () => {
  it('puts to S3 with Object Lock COMPLIANCE and retention = now + years', async () => {
    const deps = makeDeps();
    await archiveOne(deps, ingested());

    expect(deps.s3Send).toHaveBeenCalledOnce();
    const cmd = deps.s3Send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(cmd.input.ObjectLockMode).toBe('COMPLIANCE');
    expect(cmd.input.ServerSideEncryption).toBe('aws:kms');
    expect(cmd.input.SSEKMSKeyId).toBe(deps.kmsKeyId);
    const retain = cmd.input.ObjectLockRetainUntilDate as Date;
    expect(retain.getUTCFullYear()).toBe(2033); // 2026 + 7
  });

  it('uses a content-addressed S3 key so retries are idempotent', async () => {
    const deps = makeDeps();
    const m = ingested();
    await archiveOne(deps, m);
    await archiveOne(deps, m);
    const key1 = (deps.s3Send.mock.calls[0]![0] as { input: { Key: string } }).input.Key;
    const key2 = (deps.s3Send.mock.calls[1]![0] as { input: { Key: string } }).input.Key;
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^firm_testco1\/2026\/04\/21\/[a-f0-9]{64}\.json$/);
  });

  it('rejects messages from a different firm than the Lambda is bound to', async () => {
    const deps = makeDeps();
    await expect(archiveOne(deps, ingested({ firm_id: 'firm_otherxx' }))).rejects.toThrow(
      /firm_id mismatch/,
    );
    expect(deps.s3Send).not.toHaveBeenCalled();
  });

  it('inserts message_meta inside a transaction', async () => {
    const deps = makeDeps();
    await archiveOne(deps, ingested());
    expect(deps.withTx).toHaveBeenCalledOnce();
    const sqlCalls = deps.txExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes('INSERT INTO message_meta'))).toBe(true);
    expect(sqlCalls.some((s) => s.includes("nextval('archive_seq')"))).toBe(true);
  });
});

describe('handle (SQS event)', () => {
  function sqsEvent(bodies: unknown[]): SQSEvent {
    return {
      Records: bodies.map((b, i) => ({
        messageId: `m-${i}`,
        receiptHandle: '',
        body: typeof b === 'string' ? b : JSON.stringify(b),
        attributes: {} as never,
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: '',
        awsRegion: 'us-east-1',
      })),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty failures on success', async () => {
    const deps = makeDeps();
    const res = await handle(sqsEvent([ingested()]), deps);
    expect(res.batchItemFailures).toEqual([]);
  });

  it('reports per-record failures without aborting the batch', async () => {
    const deps = makeDeps();
    const res = await handle(
      sqsEvent([ingested(), ingested({ firm_id: 'firm_otherxx', message_id: 'imsg:bad' })]),
      deps,
    );
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-1' }]);
  });

  it('tolerates unparseable bodies by failing just that record', async () => {
    const deps = makeDeps();
    const res = await handle(sqsEvent(['{not json']), deps);
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm-0' }]);
  });
});
