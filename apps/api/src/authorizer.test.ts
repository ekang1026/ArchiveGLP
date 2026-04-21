import crypto from 'node:crypto';
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.FIRM_ID = 'firm_testco1';
process.env.DB_CLUSTER_ARN = 'arn:aws:rds:us-east-1:111111111111:cluster:c';
process.env.DB_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:111111111111:secret:s';
process.env.DB_NAME = 'archiveglp';

const { handle } = await import('./authorizer.js');
const { bodySha256Hex, canonicalString } = await import('./lib/signing.js');

function genSignedHeaders(method: string, path: string, body: string, tsOffsetSeconds = 0) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const ts = Math.floor(new Date('2026-04-21T18:04:13Z').getTime() / 1000) + tsOffsetSeconds;
  const bodyHash = bodySha256Hex(body);
  const signer = crypto.createSign('sha256');
  signer.update(canonicalString(method, path, ts, bodyHash));
  signer.end();
  const sig = signer.sign({ key: privateKey, dsaEncoding: 'der' });
  return {
    spkiB64,
    headers: {
      'X-ArchiveGLP-Device': 'dev_macbook01',
      'X-ArchiveGLP-Timestamp': String(ts),
      'X-ArchiveGLP-Body-Sha256': bodyHash,
      'X-ArchiveGLP-Signature': sig.toString('base64'),
    } as Record<string, string>,
  };
}

function makeEvent(headers: Record<string, string>): APIGatewayRequestAuthorizerEventV2 {
  return {
    version: '2.0',
    type: 'REQUEST',
    routeArn: 'arn:aws:execute-api:us-east-1:111111111111:xxx/$default/POST/v1/ingest',
    identitySource: [],
    routeKey: 'POST /v1/ingest',
    rawPath: '/v1/ingest',
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '111111111111',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: {
        method: 'POST',
        path: '/v1/ingest',
        protocol: 'HTTP/1.1',
        sourceIp: '1',
        userAgent: 'x',
      },
      requestId: 'r',
      routeKey: 'POST /v1/ingest',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
  } as unknown as APIGatewayRequestAuthorizerEventV2;
}

function makeDb(rows: Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValue({ rows, numberOfRecordsUpdated: 0 });
  return { db: { execute } as unknown as import('./lib/db.js').Db, execute };
}

const now = () => new Date('2026-04-21T18:04:13Z');

describe('authorizer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies when signing headers are missing', async () => {
    const { db } = makeDb([]);
    const res = await handle(makeEvent({}), { db, firmId: 'firm_testco1', now });
    expect(res.isAuthorized).toBe(false);
  });

  it('denies a stale timestamp', async () => {
    const body = '{"messages":[]}';
    const { spkiB64, headers } = genSignedHeaders('POST', '/v1/ingest', body, -10_000);
    const { db } = makeDb([
      { '0': spkiB64, '1': 'emp_jane42xx', '2': 'firm_testco1' },
    ]);
    const res = await handle(makeEvent(headers), { db, firmId: 'firm_testco1', now });
    expect(res.isAuthorized).toBe(false);
  });

  it('denies an unknown device', async () => {
    const body = '{"messages":[]}';
    const { headers } = genSignedHeaders('POST', '/v1/ingest', body);
    const { db } = makeDb([]);
    const res = await handle(makeEvent(headers), { db, firmId: 'firm_testco1', now });
    expect(res.isAuthorized).toBe(false);
  });

  it('denies a signature that does not verify against the stored key', async () => {
    const body = '{"messages":[]}';
    const { headers } = genSignedHeaders('POST', '/v1/ingest', body);
    // Store a different SPKI for this device.
    const { publicKey: otherPub } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const otherSpki = otherPub.export({ format: 'der', type: 'spki' }).toString('base64');
    const { db } = makeDb([{ '0': otherSpki, '1': 'emp_jane42xx', '2': 'firm_testco1' }]);
    const res = await handle(makeEvent(headers), { db, firmId: 'firm_testco1', now });
    expect(res.isAuthorized).toBe(false);
  });

  it('allows a correctly signed fresh request and returns context', async () => {
    const body = '{"messages":[]}';
    const { spkiB64, headers } = genSignedHeaders('POST', '/v1/ingest', body);
    const { db } = makeDb([{ '0': spkiB64, '1': 'emp_jane42xx', '2': 'firm_testco1' }]);
    const res = await handle(makeEvent(headers), { db, firmId: 'firm_testco1', now });
    expect(res.isAuthorized).toBe(true);
    expect(res.context).toEqual({
      device_id: 'dev_macbook01',
      employee_id: 'emp_jane42xx',
      firm_id: 'firm_testco1',
    });
  });
});
