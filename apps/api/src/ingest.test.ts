import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ENV = {
  FIRM_ID: 'firm_abc123',
  INGEST_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/111111111111/archiveglp-ingest.fifo',
  AWS_REGION: 'us-east-1',
};

// Stub env before importing the handler (it reads at module load).
process.env.FIRM_ID = ENV.FIRM_ID;
process.env.INGEST_QUEUE_URL = ENV.INGEST_QUEUE_URL;
process.env.AWS_REGION = ENV.AWS_REGION;

const { handle } = await import('./ingest.js');

function makeEvent(body: unknown): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/ingest',
    rawPath: '/v1/ingest',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: {
      accountId: '111111111111',
      apiId: 'x',
      domainName: 'x',
      domainPrefix: 'x',
      http: { method: 'POST', path: '/v1/ingest', protocol: 'HTTP/1.1', sourceIp: '1', userAgent: 'x' },
      requestId: 'r',
      routeKey: 'POST /v1/ingest',
      stage: '$default',
      time: 't',
      timeEpoch: 0,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

function validMessage(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    firm_id: ENV.FIRM_ID,
    employee_id: 'emp_jane42xx',
    device_id: 'dev_macbook01',
    source: 'imessage',
    conversation_id: 'chat:+15551234567',
    message_id: 'imsg:guid=ABC',
    captured_at: '2026-04-21T18:04:12.221Z',
    direction: 'inbound',
    from: { handle: '+15551234567' },
    to: [{ handle: 'jane@example.com' }],
    body_text: 'hi',
    body_edits: [],
    unsent: false,
    attachments: [],
    ...overrides,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    messages: [validMessage()],
    client_batch_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    client_sig: 'ecdsa-p256:stub',
    ...overrides,
  };
}

describe('ingest handler', () => {
  let send: ReturnType<typeof vi.fn>;
  const now = () => new Date('2026-04-21T18:04:13.000Z');

  beforeEach(() => {
    send = vi.fn().mockResolvedValue(undefined);
  });

  it('accepts a valid envelope and enriches ingested_at', async () => {
    const res = await handle(makeEvent(validEnvelope()), { send, now });
    expect(res).toMatchObject({ statusCode: 202 });
    expect(send).toHaveBeenCalledOnce();
    const [payloads, groupId] = send.mock.calls[0]!;
    expect(groupId).toBe('emp_jane42xx');
    expect(payloads[0].ingested_at).toBe('2026-04-21T18:04:13.000Z');
  });

  it('rejects invalid JSON', async () => {
    const res = await handle(makeEvent('{not json'), { send, now });
    expect(res).toMatchObject({ statusCode: 400 });
  });

  it('rejects envelopes that fail schema validation', async () => {
    const bad = { ...validEnvelope(), messages: [{ foo: 'bar' }] };
    const res = await handle(makeEvent(bad), { send, now });
    expect(res).toMatchObject({ statusCode: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects messages from a different firm_id than the tenant', async () => {
    const bad = validEnvelope({
      messages: [validMessage({ firm_id: 'firm_otherxx' })],
    });
    const res = await handle(makeEvent(bad), { send, now });
    expect(res).toMatchObject({ statusCode: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('groups messages by employee_id for FIFO ordering', async () => {
    const body = validEnvelope({
      messages: [
        validMessage({ employee_id: 'emp_jane42xx', message_id: 'imsg:1' }),
        validMessage({ employee_id: 'emp_bobbob99', message_id: 'imsg:2' }),
        validMessage({ employee_id: 'emp_jane42xx', message_id: 'imsg:3' }),
      ],
    });
    await handle(makeEvent(body), { send, now });
    expect(send).toHaveBeenCalledTimes(2);
    const groups = send.mock.calls.map((c) => c[1]).sort();
    expect(groups).toEqual(['emp_bobbob99', 'emp_jane42xx']);
  });
});
