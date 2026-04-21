import { describe, expect, it } from 'vitest';
import { FirmConfig, Message, RETENTION_YEARS_MIN } from './index.js';

describe('FirmConfig', () => {
  it('rejects retention below the SEC 17a-4(b)(4) floor', () => {
    const result = FirmConfig.safeParse({
      firm_id: 'firm_abc123',
      display_name: 'Example RIA',
      retention_years: RETENTION_YEARS_MIN - 1,
      legal_hold_default: false,
      primary_region: 'us-east-1',
      replica_region: 'us-west-2',
      d3p_principal_arn: 'arn:aws:iam::123456789012:role/D3PReader',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a well-formed config at the floor', () => {
    const result = FirmConfig.safeParse({
      firm_id: 'firm_abc123',
      display_name: 'Example RIA',
      retention_years: RETENTION_YEARS_MIN,
      legal_hold_default: false,
      primary_region: 'us-east-1',
      replica_region: 'us-west-2',
      d3p_principal_arn: 'arn:aws:iam::123456789012:role/D3PReader',
    });
    expect(result.success).toBe(true);
  });
});

describe('Message', () => {
  it('parses a minimal inbound iMessage', () => {
    const result = Message.safeParse({
      schema_version: 1,
      firm_id: 'firm_abc123',
      employee_id: 'emp_jane42',
      device_id: 'dev_macbook01',
      source: 'imessage',
      conversation_id: 'chat:+15551234567',
      message_id: 'imsg:guid=ABC',
      captured_at: '2026-04-21T18:04:12.221Z',
      direction: 'inbound',
      from: { handle: '+15551234567' },
      to: [{ handle: 'jane@example.com' }],
      body_text: 'hello',
    });
    expect(result.success).toBe(true);
  });
});
