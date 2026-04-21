import { execute, str } from './db';
import { serverEnv } from './env';

export interface DeviceRow {
  device_id: string;
  employee_id: string;
  agent_version: string | null;
  os_version: string | null;
  enrolled_at: string | null;
  last_heartbeat_at: string | null;
  last_captured_at: string | null;
  status: string;
  queue_depth: number;
  clock_skew_ms: number;
}

export interface DeviceHealth extends DeviceRow {
  silent_seconds: number | null;
  is_silent: boolean;
}

export const SILENT_THRESHOLD_SECONDS = 300; // 5 min per operations runbook

export function computeHealth(row: DeviceRow, now: Date): DeviceHealth {
  if (!row.last_heartbeat_at) {
    return { ...row, silent_seconds: null, is_silent: row.status !== 'healthy' };
  }
  const last = new Date(row.last_heartbeat_at).getTime();
  const silentSeconds = Math.max(0, Math.floor((now.getTime() - last) / 1000));
  return {
    ...row,
    silent_seconds: silentSeconds,
    is_silent: silentSeconds > SILENT_THRESHOLD_SECONDS || row.status !== 'healthy',
  };
}

const LIST_SQL = `
  SELECT
    device_id, employee_id, agent_version, os_version, enrolled_at,
    last_heartbeat_at, last_captured_at, status, queue_depth, clock_skew_ms
  FROM device
  WHERE firm_id = :firm_id
  ORDER BY (status = 'healthy') ASC, last_heartbeat_at ASC NULLS FIRST
`.trim();

export async function listDeviceHealth(now: Date = new Date()): Promise<DeviceHealth[]> {
  const env = serverEnv();
  const res = await execute(LIST_SQL, [str('firm_id', env.FIRM_ID)]);
  return res.rows.map((r) => {
    const row: DeviceRow = {
      device_id: String(r['0']),
      employee_id: String(r['1']),
      agent_version: (r['2'] as string | null) ?? null,
      os_version: (r['3'] as string | null) ?? null,
      enrolled_at: (r['4'] as string | null) ?? null,
      last_heartbeat_at: (r['5'] as string | null) ?? null,
      last_captured_at: (r['6'] as string | null) ?? null,
      status: String(r['7']),
      queue_depth: Number(r['8'] ?? 0),
      clock_skew_ms: Number(r['9'] ?? 0),
    };
    return computeHealth(row, now);
  });
}
