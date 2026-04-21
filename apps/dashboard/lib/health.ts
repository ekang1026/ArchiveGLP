/**
 * Device health derivation. The `device` table stores raw fields; the
 * dashboard computes an overall status + reason list from them. This
 * lives in one place so the fleet overview and per-device page agree
 * on what "warning" vs "critical" means.
 */

/**
 * Level ordering (non-administrative): healthy < warning < silent <
 * critical. `silent` sits above `warning` and below `critical`
 * because "agent is alive but no messages are flowing" is the
 * scenario supervisors most care about — more actionable than a
 * warning gauge, less severe than an unresponsive agent. `paused`
 * and `revoked` are administrative short-circuits handled up front.
 */
export type HealthLevel =
  | 'healthy'
  | 'warning'
  | 'silent'
  | 'critical'
  | 'paused'
  | 'revoked';

export interface DeviceHealthInput {
  last_heartbeat_at: string | null;
  last_captured_at: string | null;
  enrolled_at: string | null;
  disk_free_gb: number | string | null;
  memory_free_mb: number | string | null;
  messages_app_running: boolean | null;
  fda_status: string | null;
  queue_depth: number | null;
  clock_skew_ms: number | null;
  paused: boolean | null;
  revoked_at: string | null;
}

export interface DeviceHealth {
  level: HealthLevel;
  reasons: string[];
  heartbeat_age_seconds: number | null;
  captured_age_seconds: number | null;
}

const HEARTBEAT_WARN_SECONDS = 5 * 60;
const HEARTBEAT_CRIT_SECONDS = 30 * 60;
const DISK_WARN_GB = 10;
const DISK_CRIT_GB = 2;
const QUEUE_WARN = 1000;
const QUEUE_CRIT = 5000;
const CLOCK_SKEW_WARN_MS = 5_000;
const CLOCK_SKEW_CRIT_MS = 60_000;
// "Silent" detection: agent heartbeats freshly but has captured no
// messages for a long time. 4h warn / 24h crit mirrors typical
// advisor messaging cadence — a day without any captures on a
// working device is the exact signal supervisors asked for.
const SILENT_WARN_SECONDS = 4 * 3600;
const SILENT_CRIT_SECONDS = 24 * 3600;
// Grace period after enrollment before silent detection applies.
// Avoids false positives on freshly-enrolled devices that haven't
// yet had a chance to receive a message.
const SILENT_ENROLL_GRACE_SECONDS = SILENT_WARN_SECONDS;

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function computeHealth(d: DeviceHealthInput, now: Date = new Date()): DeviceHealth {
  if (d.revoked_at) {
    return {
      level: 'revoked',
      reasons: ['device revoked'],
      heartbeat_age_seconds: null,
      captured_age_seconds: null,
    };
  }
  if (d.paused) {
    return {
      level: 'paused',
      reasons: ['capture paused'],
      heartbeat_age_seconds: null,
      captured_age_seconds: null,
    };
  }

  const reasons: string[] = [];
  let level: HealthLevel = 'healthy';
  // Ordering: healthy(0) < warning(1) < silent(2) < critical(3).
  // paused/revoked handled above.
  const rank: Record<'healthy' | 'warning' | 'silent' | 'critical', number> = {
    healthy: 0,
    warning: 1,
    silent: 2,
    critical: 3,
  };
  const bump = (l: 'warning' | 'silent' | 'critical') => {
    if (rank[l] > rank[level as 'healthy' | 'warning' | 'silent' | 'critical']) {
      level = l;
    }
  };

  let heartbeatAge: number | null = null;
  if (d.last_heartbeat_at) {
    const ts = Date.parse(d.last_heartbeat_at);
    if (Number.isFinite(ts)) {
      heartbeatAge = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
      if (heartbeatAge > HEARTBEAT_CRIT_SECONDS) {
        bump('critical');
        reasons.push(`heartbeat stale ${formatAge(heartbeatAge)}`);
      } else if (heartbeatAge > HEARTBEAT_WARN_SECONDS) {
        bump('warning');
        reasons.push(`heartbeat stale ${formatAge(heartbeatAge)}`);
      }
    }
  } else {
    bump('critical');
    reasons.push('no heartbeat ever received');
  }

  const disk = toNum(d.disk_free_gb);
  if (disk !== null) {
    if (disk < DISK_CRIT_GB) {
      bump('critical');
      reasons.push(`disk free ${disk.toFixed(1)} GB`);
    } else if (disk < DISK_WARN_GB) {
      bump('warning');
      reasons.push(`disk free ${disk.toFixed(1)} GB`);
    }
  }

  if (d.messages_app_running === false) {
    bump('critical');
    reasons.push('Messages.app not running');
  }

  if (d.fda_status && d.fda_status !== 'granted') {
    bump('critical');
    reasons.push(`FDA ${d.fda_status}`);
  }

  const queue = toNum(d.queue_depth);
  if (queue !== null) {
    if (queue >= QUEUE_CRIT) {
      bump('critical');
      reasons.push(`queue backlog ${queue}`);
    } else if (queue >= QUEUE_WARN) {
      bump('warning');
      reasons.push(`queue backlog ${queue}`);
    }
  }

  const skew = toNum(d.clock_skew_ms);
  if (skew !== null) {
    const abs = Math.abs(skew);
    if (abs >= CLOCK_SKEW_CRIT_MS) {
      bump('critical');
      reasons.push(`clock skew ${(abs / 1000).toFixed(1)}s`);
    } else if (abs >= CLOCK_SKEW_WARN_MS) {
      bump('warning');
      reasons.push(`clock skew ${(abs / 1000).toFixed(1)}s`);
    }
  }

  // Silent detection: if the agent is heartbeating (heartbeat fresh
  // enough that we believe the process is alive), but has captured
  // nothing for a long time, the forwarder is stuck even though the
  // supervisor dashboard says "healthy". This is the condition
  // supervisors asked about explicitly. Skipped while device is in
  // its post-enrollment grace window.
  let capturedAge: number | null = null;
  if (d.last_captured_at) {
    const cts = Date.parse(d.last_captured_at);
    if (Number.isFinite(cts)) {
      capturedAge = Math.max(0, Math.floor((now.getTime() - cts) / 1000));
    }
  }

  const enrolledAgeSeconds = d.enrolled_at
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(d.enrolled_at)) / 1000))
    : 0;
  const pastGrace = enrolledAgeSeconds > SILENT_ENROLL_GRACE_SECONDS;
  const heartbeatFresh =
    heartbeatAge !== null && heartbeatAge <= HEARTBEAT_WARN_SECONDS;

  if (heartbeatFresh && pastGrace) {
    const effectiveCapturedAge =
      capturedAge === null ? enrolledAgeSeconds : capturedAge;
    if (effectiveCapturedAge > SILENT_CRIT_SECONDS) {
      bump('critical');
      reasons.push(
        `silent ${formatAge(effectiveCapturedAge)} (agent alive, no messages)`,
      );
    } else if (effectiveCapturedAge > SILENT_WARN_SECONDS) {
      bump('silent');
      reasons.push(
        `silent ${formatAge(effectiveCapturedAge)} (agent alive, no messages)`,
      );
    }
  }

  if (reasons.length === 0) reasons.push('all checks passing');
  return {
    level,
    reasons,
    heartbeat_age_seconds: heartbeatAge,
    captured_age_seconds: capturedAge,
  };
}

export function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export const HEALTH_COLORS: Record<HealthLevel, { bg: string; fg: string; border: string }> = {
  healthy: { bg: '#e7f6ec', fg: '#15612a', border: '#b3dec0' },
  warning: { bg: '#fff5db', fg: '#8a5b00', border: '#f0d88a' },
  // Distinct from warning's yellow: silent uses orange so "stuck
  // forwarder" stands out at a glance on the fleet overview.
  silent: { bg: '#ffe4cc', fg: '#8a4a00', border: '#f0b88a' },
  critical: { bg: '#fde8e8', fg: '#9a1c1c', border: '#f4b8b8' },
  paused: { bg: '#eef0f3', fg: '#555', border: '#cfd3da' },
  revoked: { bg: '#2a2a2a', fg: '#ffffff', border: '#444' },
};
