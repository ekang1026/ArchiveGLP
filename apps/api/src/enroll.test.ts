import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.FIRM_ID = 'firm_testco1';
process.env.RETENTION_YEARS = '7';
process.env.ARCHIVE_BUCKET = 'archiveglp-firm-testco1-archive-us-east-1';
process.env.ARCHIVE_KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/abc';
process.env.DB_CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:c';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s';
process.env.DB_NAME = 'archiveglp';

const { handle } = await import('./enroll.js');

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/enroll',
    rawPath: '/v1/enroll',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '111111111111',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method: 'POST', path: '/v1/enroll', protocol: 'HTTP/1.1', sourceIp: '1', userAgent: 'x' },
      requestId: 'r',
      routeKey: 'POST /v1/enroll',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function validRequest(overrides: { pending?: Record<string, unknown>; attestation?: Record<string, unknown> } = {}) {
  return {
    pairing_code: 'pair-abcdefghijklmnop',
    attestation: {
      schema_version: 1,
      firm_id: 'firm_testco1',
      employee_id: 'emp_jane42xx',
      device_id: 'dev_macbook01',
      employee_full_name_typed: 'Jane Q Advisor',
      employee_email: 'jane@firm.example',
      disclosures_version: '2026-04-21.v1',
      disclosures_shown: ['data-captured', 'purpose', 'retention', 'visibility', 'revocation'],
      attested_at: '2026-04-21T18:04:12.000Z',
      device_public_key_spki_b64: 'c3BraS1kZXI=',
      os_version: 'Darwin 23.4.0',
      agent_version: '0.0.1',
      ...overrides.attestation,
    },
  };
}

interface TxRow {
  sql: string;
  rows: Record<string, unknown>[];
}

function makeDb(rows: TxRow[]) {
  const txExecute = vi.fn(async (sql: string) => {
    const next = rows.find((r) => sql.includes(r.sql));
    return { rows: next?.rows ?? [], numberOfRecordsUpdated: 1 };
  });
  const withTx = vi.fn(
    async (fn: (tx: { execute: typeof txExecute }) => Promise<unknown>) => fn({ execute: txExecute }),
  );
  return {
    db: { withTx } as unknown as import('./lib/db.js').Db,
    withTx,
    txExecute,
  };
}

function makeDeps(opts: { rows?: TxRow[]; s3Send?: ReturnType<typeof vi.fn> } = {}) {
  const { db, txExecute } = makeDb(opts.rows ?? []);
  const s3Send = opts.s3Send ?? vi.fn().mockResolvedValue({});
  return {
    s3: { send: s3Send } as unknown as import('@aws-sdk/client-s3').S3Client,
    s3Send,
    db,
    txExecute,
    now: () => new Date('2026-04-21T18:04:13.000Z'),
    firmId: 'firm_testco1',
    retentionYears: 7,
    bucket: process.env.ARCHIVE_BUCKET!,
    kmsKeyId: process.env.ARCHIVE_KEY_ARN!,
  };
}

describe('enroll handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a firm_id not bound to this tenant', async () => {
    const deps = makeDeps();
    const body = validRequest({ attestation: { firm_id: 'firm_otherxx' } });
    const res = await handle(makeEvent(body), deps);
    expect(res).toMatchObject({ statusCode: 403 });
    expect(deps.s3Send).not.toHaveBeenCalled();
  });

  it('rejects an unknown or expired pairing_code', async () => {
    const deps = makeDeps({
      rows: [{ sql: 'FROM pending_enrollment', rows: [] }],
    });
    const res = await handle(makeEvent(validRequest()), deps);
    expect(res).toMatchObject({ statusCode: 403 });
    expect(deps.s3Send).not.toHaveBeenCalled();
  });

  it('rejects when pairing_code is bound to a different employee', async () => {
    const deps = makeDeps({
      rows: [
        {
          sql: 'FROM pending_enrollment',
          rows: [
            {
              '0': 'firm_testco1',
              '1': 'emp_otherperson',
              '2': 'someone@firm.example',
              '3': 'Someone Else',
            },
          ],
        },
      ],
    });
    const res = await handle(makeEvent(validRequest()), deps);
    expect(res).toMatchObject({ statusCode: 403 });
    expect(deps.s3Send).not.toHaveBeenCalled();
  });

  it('refuses to re-enroll an existing device_id', async () => {
    const deps = makeDeps({
      rows: [
        {
          sql: 'FROM pending_enrollment',
          rows: [
            {
              '0': 'firm_testco1',
              '1': 'emp_jane42xx',
              '2': 'jane@firm.example',
              '3': 'Jane Q Advisor',
            },
          ],
        },
        { sql: 'FROM device WHERE device_id', rows: [{ '0': 1 }] },
      ],
    });
    const res = await handle(makeEvent(validRequest()), deps);
    expect(res).toMatchObject({ statusCode: 409 });
  });

  it('accepts a valid pairing_code, writes device row, archives attestation to S3', async () => {
    const deps = makeDeps({
      rows: [
        {
          sql: 'FROM pending_enrollment',
          rows: [
            {
              '0': 'firm_testco1',
              '1': 'emp_jane42xx',
              '2': 'jane@firm.example',
              '3': 'Jane Q Advisor',
            },
          ],
        },
        { sql: 'FROM device WHERE device_id', rows: [] },
      ],
    });
    const res = await handle(makeEvent(validRequest()), deps);
    expect(res).toMatchObject({ statusCode: 204 });

    const sqlCalls = deps.txExecute.mock.calls.map((c) => c[0] as string);
    expect(sqlCalls.some((s) => s.includes('INSERT INTO device'))).toBe(true);
    expect(sqlCalls.some((s) => s.includes('UPDATE pending_enrollment'))).toBe(true);

    expect(deps.s3Send).toHaveBeenCalledOnce();
    const putCmd = deps.s3Send.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(putCmd.input.ObjectLockMode).toBe('COMPLIANCE');
    expect(String(putCmd.input.Key)).toContain('_enrollments');
  });
});
