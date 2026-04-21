import { describe, expect, it } from 'vitest';
import { type DeviceHealthInput, computeHealth } from './health';

const NOW = new Date('2026-04-21T18:00:00Z');

function baseline(overrides: Partial<DeviceHealthInput> = {}): DeviceHealthInput {
  return {
    last_heartbeat_at: NOW.toISOString(),
    last_captured_at: NOW.toISOString(),
    enrolled_at: new Date(NOW.getTime() - 7 * 24 * 3600 * 1000).toISOString(),
    disk_free_gb: 100,
    memory_free_mb: 8000,
    messages_app_running: true,
    fda_status: 'granted',
    queue_depth: 0,
    clock_skew_ms: 0,
    paused: false,
    revoked_at: null,
    ...overrides,
  };
}

describe('computeHealth', () => {
  it('is healthy when every check passes', () => {
    expect(computeHealth(baseline(), NOW).level).toBe('healthy');
  });

  it('flags silent when heartbeat fresh but captures stale > 4h', () => {
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 3600 * 1000).toISOString();
    const h = computeHealth(baseline({ last_captured_at: fiveHoursAgo }), NOW);
    expect(h.level).toBe('silent');
    expect(h.reasons.some((r) => r.includes('silent'))).toBe(true);
  });

  it('escalates silent to critical when captures stale > 24h', () => {
    const longAgo = new Date(NOW.getTime() - 30 * 3600 * 1000).toISOString();
    const h = computeHealth(baseline({ last_captured_at: longAgo }), NOW);
    expect(h.level).toBe('critical');
  });

  it('does not flag silent within the post-enrollment grace window', () => {
    const justEnrolled = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
    // last_captured_at null — but device only enrolled 30 min ago,
    // so silent detection must not fire yet.
    const h = computeHealth(
      baseline({ last_captured_at: null, enrolled_at: justEnrolled }),
      NOW,
    );
    expect(h.level).toBe('healthy');
  });

  it('does not flag silent when heartbeat itself is stale (critical wins)', () => {
    const h = computeHealth(
      baseline({
        last_heartbeat_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
        last_captured_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      }),
      NOW,
    );
    // Heartbeat stale -> critical; silent check is gated on
    // heartbeat being fresh.
    expect(h.level).toBe('critical');
    expect(h.reasons.some((r) => r.includes('silent'))).toBe(false);
  });

  it('silent ranks above warning (disk low) but below critical', () => {
    const h = computeHealth(
      baseline({
        last_captured_at: new Date(NOW.getTime() - 6 * 3600 * 1000).toISOString(),
        disk_free_gb: 5, // warning threshold
      }),
      NOW,
    );
    expect(h.level).toBe('silent');
  });

  it('critical overrides silent', () => {
    const h = computeHealth(
      baseline({
        last_captured_at: new Date(NOW.getTime() - 6 * 3600 * 1000).toISOString(),
        disk_free_gb: 1, // critical threshold
      }),
      NOW,
    );
    expect(h.level).toBe('critical');
  });

  it('reports captured_age_seconds', () => {
    const sixHoursAgo = new Date(NOW.getTime() - 6 * 3600 * 1000).toISOString();
    const h = computeHealth(baseline({ last_captured_at: sixHoursAgo }), NOW);
    expect(h.captured_age_seconds).toBe(6 * 3600);
  });

  it('paused short-circuits everything', () => {
    const h = computeHealth(
      baseline({
        paused: true,
        last_captured_at: new Date(NOW.getTime() - 48 * 3600 * 1000).toISOString(),
      }),
      NOW,
    );
    expect(h.level).toBe('paused');
  });

  it('revoked short-circuits everything', () => {
    const h = computeHealth(baseline({ revoked_at: NOW.toISOString() }), NOW);
    expect(h.level).toBe('revoked');
  });
});
