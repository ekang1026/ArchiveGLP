import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.FIRM_ID = 'firm_testco1';
process.env.DB_CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:c';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s';
process.env.DB_NAME = 'archiveglp';

const { handle } = await import('./heartbeat.js');

function makeDb(updated = 1) {
  const execute = vi.fn().mockResolvedValue({ rows: [], numberOfRecordsUpdated: updated });
  return { db: { execute } as unknown as import('./lib/db.js').Db, execute };
}

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/heartbeat',
    rawPath: '/v1/heartbeat',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '111111111111',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method: 'POST', path: '/v1/heartbeat', protocol: 'HTTP/1.1', sourceIp: '1', userAgent: 'x' },
      requestId: 'r',
      routeKey: 'POST /v1/heartbeat',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function validHeartbeat(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    firm_id: 'firm_testco1',
    employee_id: 'emp_jane42xx',
    device_id: 'dev_macbook01',
    agent_version: '0.0.1',
    os_version: '14.4',
    status: 'healthy',
    reported_at: '2026-04-21T18:04:13.000Z',
    last_captured_at: '2026-04-21T18:04:12.000Z',
    queue_depth: 0,
    clock_skew_ms: 15,
    ...overrides,
  };
}

describe('heartbeat handler', () => {
  const now = () => new Date('2026-04-21T18:04:14.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates the device row and returns 204', async () => {
    const { db, execute } = makeDb(1);
    const res = await handle(makeEvent(validHeartbeat()), {
      db,
      firmId: 'firm_testco1',
      now,
    });
    expect(res).toMatchObject({ statusCode: 204 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a body that fails schema validation', async () => {
    const { db } = makeDb();
    const res = await handle(
      makeEvent(validHeartbeat({ status: 'bogus' })),
      { db, firmId: 'firm_testco1', now },
    );
    expect(res).toMatchObject({ statusCode: 400 });
  });

  it('rejects a different firm_id', async () => {
    const { db, execute } = makeDb();
    const res = await handle(
      makeEvent(validHeartbeat({ firm_id: 'firm_otherxx' })),
      { db, firmId: 'firm_testco1', now },
    );
    expect(res).toMatchObject({ statusCode: 403 });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns 404 when the device row is unknown', async () => {
    const { db } = makeDb(0);
    const res = await handle(makeEvent(validHeartbeat()), {
      db,
      firmId: 'firm_testco1',
      now,
    });
    expect(res).toMatchObject({ statusCode: 404 });
  });

  it('handles last_captured_at being null', async () => {
    const { db, execute } = makeDb(1);
    const res = await handle(
      makeEvent(validHeartbeat({ last_captured_at: null })),
      { db, firmId: 'firm_testco1', now },
    );
    expect(res).toMatchObject({ statusCode: 204 });
    expect(execute).toHaveBeenCalledOnce();
  });
});
