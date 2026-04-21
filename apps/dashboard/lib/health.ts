/**
 * Device health derivation. The `device` table stores raw fields; the
 * dashboard computes an overall status + reason list from them. This
 * lives in one place so the fleet overview and per-device page agree
 * on what "warning" vs "critical" means.
 */

export type HealthLevel = 'healthy' | 'warning' | 'critical' | 'paused' | 'revoked';

export interface DeviceHealthInput {
  last_heartbeat_at: string | null;
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
}

const HEARTBEAT_WARN_SECONDS = 5 * 60;
const HEARTBEAT_CRIT_SECONDS = 30 * 60;
const DISK_WARN_GB = 10;
const DISK_CRIT_GB = 2;
const QUEUE_WARN = 1000;
const QUEUE_CRIT = 5000;
const CLOCK_SKEW_WARN_MS = 5_000;
const CLOCK_SKEW_CRIT_MS = 60_000;

function toNum(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export function computeHealth(d: DeviceHealthInput, now: Date = new Date()): DeviceHealth {
  if (d.revoked_at) {
    return { level: 'revoked', reasons: ['device revoked'], heartbeat_age_seconds: null };
  }
  if (d.paused) {
    return { level: 'paused', reasons: ['capture paused'], heartbeat_age_seconds: null };
  }

  const reasons: string[] = [];
  let level: HealthLevel = 'healthy';
  const bump = (l: HealthLevel) => {
    // Order: healthy < warning < critical. paused/revoked handled above.
    if (l === 'critical') level = 'critical';
    else if (l === 'warning' && level !== 'critical') level = 'warning';
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

  if (reasons.length === 0) reasons.push('all checks passing');
  return { level, reasons, heartbeat_age_seconds: heartbeatAge };
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
  critical: { bg: '#fde8e8', fg: '#9a1c1c', border: '#f4b8b8' },
  paused: { bg: '#eef0f3', fg: '#555', border: '#cfd3da' },
  revoked: { bg: '#2a2a2a', fg: '#ffffff', border: '#444' },
};
