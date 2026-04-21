import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.FIRM_ID = 'firm_testco1';
process.env.RETENTION_YEARS = '7';
process.env.ADMIN_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:adm';
process.env.DB_CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:c';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s';
process.env.DB_NAME = 'archiveglp';

const { handle } = await import('./admin.js');

function makeEvent(body: unknown, headers: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /admin/pending-enrollments',
    rawPath: '/admin/pending-enrollments',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '111111111111',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method: 'POST', path: '/admin/pending-enrollments', protocol: 'HTTP/1.1', sourceIp: '1', userAgent: 'x' },
      requestId: 'r',
      routeKey: 'POST /admin/pending-enrollments',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    firm_id: 'firm_testco1',
    employee_id: 'emp_jane42xx',
    employee_email: 'jane@firm.example',
    employee_full_name: 'Jane Q Advisor',
    expires_in_hours: 24,
    ...overrides,
  };
}

function makeDb() {
  const txExecute = vi.fn(async (_sql: string) => ({ rows: [] as Record<string, unknown>[] }));
  const withTx = vi.fn(async <T>(fn: (tx: { execute: typeof txExecute }) => Promise<T>) =>
    fn({ execute: txExecute }),
  );
  return { db: { withTx } as unknown as import('./lib/db.js').Db, txExecute, withTx };
}

const baseDeps = () => {
  const { db, txExecute, withTx } = makeDb();
  return {
    db,
    txExecute,
    withTx,
    now: () => new Date('2026-04-21T18:04:13.000Z'),
    firmId: 'firm_testco1',
    retentionYears: 7,
    adminKey: 'correct-horse-battery-staple',
  };
};

describe('admin pending-enrollments handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 when the admin key header is missing', async () => {
    const deps = baseDeps();
    const res = await handle(makeEvent(validBody()), deps);
    expect(res).toMatchObject({ statusCode: 401 });
    expect(deps.withTx).not.toHaveBeenCalled();
  });

  it('returns 403 when the admin key is wrong', async () => {
    const deps = baseDeps();
    const res = await handle(makeEvent(validBody(), { 'x-admin-key': 'wrong' }), deps);
    expect(res).toMatchObject({ statusCode: 403 });
    expect(deps.withTx).not.toHaveBeenCalled();
  });

  it('returns 400 on schema violation', async () => {
    const deps = baseDeps();
    const res = await handle(
      makeEvent(validBody({ employee_email: 'not-an-email' }), {
        'x-admin-key': deps.adminKey,
      }),
      deps,
    );
    expect(res).toMatchObject({ statusCode: 400 });
  });

  it('returns 403 when firm_id does not match the bound tenant', async () => {
    const deps = baseDeps();
    const res = await handle(
      makeEvent(validBody({ firm_id: 'firm_otherxx' }), {
        'x-admin-key': deps.adminKey,
      }),
      deps,
    );
    expect(res).toMatchObject({ statusCode: 403 });
    expect(deps.withTx).not.toHaveBeenCalled();
  });

  it('on success returns 201 with a pairing_code and expires_at, and inserts rows', async () => {
    const deps = baseDeps();
    const res = await handle(
      makeEvent(validBody(), { 'x-admin-key': deps.adminKey }),
      deps,
    );
    expect(res).toMatchObject({ statusCode: 201 });
    const body = JSON.parse((res as { body: string }).body);
    expect(body.pairing_code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // Expires at = now + 24h in our fixture.
    expect(new Date(body.expires_at).toISOString()).toBe('2026-04-22T18:04:13.000Z');

    const sqls = deps.txExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('INSERT INTO firm'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO employee'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO pending_enrollment'))).toBe(true);
  });

  it('issues distinct pairing codes on repeated calls', async () => {
    const deps = baseDeps();
    const r1 = await handle(makeEvent(validBody(), { 'x-admin-key': deps.adminKey }), deps);
    const r2 = await handle(makeEvent(validBody(), { 'x-admin-key': deps.adminKey }), deps);
    const b1 = JSON.parse((r1 as { body: string }).body);
    const b2 = JSON.parse((r2 as { body: string }).body);
    expect(b1.pairing_code).not.toEqual(b2.pairing_code);
  });
});
