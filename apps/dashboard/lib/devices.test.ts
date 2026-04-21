import { describe, expect, it } from 'vitest';
import { SILENT_THRESHOLD_SECONDS, computeHealth, type DeviceRow } from './devices';

const base: DeviceRow = {
  device_id: 'dev_macbook01',
  employee_id: 'emp_jane42xx',
  agent_version: '0.0.1',
  os_version: 'Darwin 23.4.0',
  enrolled_at: '2026-04-20T00:00:00Z',
  last_heartbeat_at: null,
  last_captured_at: null,
  status: 'healthy',
  queue_depth: 0,
  clock_skew_ms: 0,
};

describe('computeHealth', () => {
  it('marks never-heartbeated healthy devices as silent=false (awaiting first)', () => {
    const h = computeHealth(base, new Date('2026-04-21T00:00:00Z'));
    expect(h.silent_seconds).toBeNull();
    expect(h.is_silent).toBe(false);
  });

  it('flags a never-heartbeated device whose status is degraded as silent', () => {
    const h = computeHealth(
      { ...base, status: 'tcc_revoked' },
      new Date('2026-04-21T00:00:00Z'),
    );
    expect(h.is_silent).toBe(true);
  });

  it('computes silent_seconds from last_heartbeat_at', () => {
    const now = new Date('2026-04-21T18:05:00Z');
    const h = computeHealth(
      { ...base, last_heartbeat_at: '2026-04-21T18:00:00Z' },
      now,
    );
    expect(h.silent_seconds).toBe(300);
  });

  it('flags devices silent beyond the threshold', () => {
    const now = new Date('2026-04-21T18:10:00Z');
    const h = computeHealth(
      { ...base, last_heartbeat_at: '2026-04-21T18:00:00Z' },
      now,
    );
    expect(h.silent_seconds).toBe(600);
    expect(h.is_silent).toBe(true);
  });

  it('does not flag devices within the threshold', () => {
    const now = new Date('2026-04-21T18:02:00Z');
    const h = computeHealth(
      { ...base, last_heartbeat_at: '2026-04-21T18:00:00Z' },
      now,
    );
    expect(h.silent_seconds).toBe(120);
    expect(h.is_silent).toBe(false);
  });

  it('threshold is 5 minutes', () => {
    expect(SILENT_THRESHOLD_SECONDS).toBe(300);
  });
});
