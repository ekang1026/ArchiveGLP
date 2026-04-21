import Link from 'next/link';
import { recordAudit } from '../../lib/audit';
import { requireSession } from '../../lib/auth';
import {
  type DeviceHealthInput,
  HEALTH_COLORS,
  type HealthLevel,
  computeHealth,
  formatAge,
} from '../../lib/health';
import { serverConfig, serviceClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

type DeviceRow = DeviceHealthInput & {
  device_id: string;
  employee_id: string;
  hostname: string | null;
  os_version: string | null;
  agent_version: string | null;
  status: string;
};

export default async function DevicesPage() {
  const session = await requireSession();
  const cfg = serverConfig();
  const sb = serviceClient();
  const { data: rows, error } = await sb
    .from('device')
    .select(
      'device_id, employee_id, hostname, os_version, agent_version, status, last_heartbeat_at, queue_depth, disk_free_gb, memory_free_mb, messages_app_running, fda_status, clock_skew_ms, paused, revoked_at',
    )
    .eq('firm_id', cfg.FIRM_ID)
    .order('last_heartbeat_at', { ascending: true, nullsFirst: true });

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'device_list_view',
  });

  if (error) {
    return (
      <div>
        <h2>Device health</h2>
        <p style={{ color: '#a00' }}>Error loading devices: {error.message}</p>
      </div>
    );
  }

  const devices = (rows ?? []) as DeviceRow[];
  const now = new Date();
  const annotated = devices.map((d) => ({ device: d, health: computeHealth(d, now) }));

  const counts: Record<HealthLevel | 'total', number> = {
    total: annotated.length,
    healthy: 0,
    warning: 0,
    critical: 0,
    paused: 0,
    revoked: 0,
  };
  for (const a of annotated) counts[a.health.level] += 1;

  return (
    <div>
      <h2 style={{ margin: 0 }}>Device health</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
        Fleet overview for {cfg.FIRM_ID}. Click any row to drill in.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
          gap: 8,
          marginTop: 16,
          marginBottom: 20,
        }}
      >
        <SummaryCard label="Total" value={counts.total} level={null} />
        <SummaryCard label="Healthy" value={counts.healthy} level="healthy" />
        <SummaryCard label="Warning" value={counts.warning} level="warning" />
        <SummaryCard label="Critical" value={counts.critical} level="critical" />
        <SummaryCard label="Paused" value={counts.paused} level="paused" />
        <SummaryCard label="Revoked" value={counts.revoked} level="revoked" />
      </div>

      {annotated.length === 0 ? (
        <p style={{ color: '#666' }}>No devices enrolled.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={thStyle}>device</th>
              <th style={thStyle}>employee</th>
              <th style={thStyle}>status</th>
              <th style={thStyle}>reasons</th>
              <th style={thStyle}>heartbeat</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>queue</th>
              <th style={thStyle}>agent</th>
              <th style={thStyle}>os</th>
            </tr>
          </thead>
          <tbody>
            {annotated.map(({ device, health }) => {
              const color = HEALTH_COLORS[health.level];
              return (
                <tr key={device.device_id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={tdStyle}>
                    <Link
                      href={`/devices/${encodeURIComponent(device.device_id)}`}
                      style={{ color: '#06c', textDecoration: 'none' }}
                    >
                      <div style={{ fontWeight: 600 }}>{device.hostname ?? device.device_id}</div>
                      {device.hostname && (
                        <div style={{ color: '#888', fontFamily: 'monospace', fontSize: 11 }}>
                          {device.device_id}
                        </div>
                      )}
                    </Link>
                  </td>
                  <td style={tdStyle}>{device.employee_id}</td>
                  <td style={tdStyle}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '2px 8px',
                        background: color.bg,
                        color: color.fg,
                        border: `1px solid ${color.border}`,
                        borderRadius: 999,
                        fontSize: 11,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: 0.3,
                      }}
                    >
                      {health.level}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, color: '#555' }}>{health.reasons.join(' · ')}</td>
                  <td style={tdStyle}>
                    {health.heartbeat_age_seconds === null
                      ? '—'
                      : `${formatAge(health.heartbeat_age_seconds)} ago`}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {(device as unknown as { queue_depth: number }).queue_depth ?? 0}
                  </td>
                  <td style={tdStyle}>{device.agent_version ?? '—'}</td>
                  <td style={tdStyle}>{device.os_version ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p style={{ color: '#666', fontSize: 12, marginTop: 24 }}>Signed in as {session.email}.</p>
    </div>
  );
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '6px 8px', verticalAlign: 'top' as const };

function SummaryCard({
  label,
  value,
  level,
}: {
  label: string;
  value: number;
  level: HealthLevel | null;
}) {
  const color = level ? HEALTH_COLORS[level] : { bg: '#fff', fg: '#222', border: '#ddd' };
  return (
    <div
      style={{
        padding: 12,
        background: color.bg,
        color: color.fg,
        border: `1px solid ${color.border}`,
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
