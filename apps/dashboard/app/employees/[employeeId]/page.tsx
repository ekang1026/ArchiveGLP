import Link from 'next/link';
import { notFound } from 'next/navigation';
import { recordAudit } from '../../../lib/audit';
import { requireSession } from '../../../lib/auth';
import {
  type DeviceHealthInput,
  HEALTH_COLORS,
  computeHealth,
  formatAge,
} from '../../../lib/health';
import { serverConfig, serviceClient } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ employeeId: string }>;
}

type DeviceRow = DeviceHealthInput & {
  device_id: string;
  hostname: string | null;
  agent_version: string | null;
  os_version: string | null;
};

export default async function EmployeePage({ params }: PageProps) {
  const session = await requireSession();
  const { employeeId } = await params;
  const cfg = serverConfig();
  const sb = serviceClient();

  const { data: employee, error: empErr } = await sb
    .from('employee')
    .select('employee_id, firm_id, email, full_name, active, enrolled_at')
    .eq('firm_id', cfg.FIRM_ID)
    .eq('employee_id', employeeId)
    .maybeSingle();

  if (empErr) {
    return (
      <div>
        <h2>Employee</h2>
        <p style={{ color: '#a00' }}>Error loading employee: {empErr.message}</p>
      </div>
    );
  }
  if (!employee) notFound();

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();

  const [
    { data: devices },
    { count: count24h },
    { count: count7d },
    { count: count30d },
    { data: recentMessages },
  ] = await Promise.all([
    sb
      .from('device')
      .select(
        'device_id, hostname, agent_version, os_version, last_heartbeat_at, disk_free_gb, memory_free_mb, messages_app_running, fda_status, queue_depth, clock_skew_ms, paused, revoked_at',
      )
      .eq('firm_id', cfg.FIRM_ID)
      .eq('employee_id', employeeId)
      .order('enrolled_at', { ascending: true }),
    sb
      .from('message_meta')
      .select('archive_seq', { count: 'exact', head: true })
      .eq('firm_id', cfg.FIRM_ID)
      .eq('employee_id', employeeId)
      .gte('captured_at', dayAgo),
    sb
      .from('message_meta')
      .select('archive_seq', { count: 'exact', head: true })
      .eq('firm_id', cfg.FIRM_ID)
      .eq('employee_id', employeeId)
      .gte('captured_at', weekAgo),
    sb
      .from('message_meta')
      .select('archive_seq', { count: 'exact', head: true })
      .eq('firm_id', cfg.FIRM_ID)
      .eq('employee_id', employeeId)
      .gte('captured_at', monthAgo),
    sb
      .from('message_meta')
      .select('archive_seq, direction, from_handle, captured_at')
      .eq('firm_id', cfg.FIRM_ID)
      .eq('employee_id', employeeId)
      .order('captured_at', { ascending: false })
      .limit(10),
  ]);

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'page_view',
    targetType: 'employee',
    targetId: employeeId,
  });

  const deviceRows = (devices ?? []) as DeviceRow[];
  const annotated = deviceRows.map((d) => ({ device: d, health: computeHealth(d, now) }));

  return (
    <div>
      <nav style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href="/employees" style={{ color: '#06c' }}>
          ← All employees
        </Link>
      </nav>
      <h2 style={{ margin: 0 }}>{employee.full_name}</h2>
      <div style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
        {employee.email} · <span style={{ fontFamily: 'monospace' }}>{employee.employee_id}</span>
        {!employee.active && (
          <span
            style={{
              marginLeft: 8,
              padding: '2px 6px',
              background: '#eee',
              borderRadius: 4,
              fontSize: 11,
            }}
          >
            inactive
          </span>
        )}
      </div>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Message volume</h3>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 8,
          }}
        >
          <VolumeCard label="Last 24h" value={count24h ?? 0} />
          <VolumeCard label="Last 7 days" value={count7d ?? 0} />
          <VolumeCard label="Last 30 days" value={count30d ?? 0} />
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Devices ({annotated.length})</h3>
        {annotated.length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>No devices enrolled.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>device</th>
                <th style={thStyle}>status</th>
                <th style={thStyle}>reasons</th>
                <th style={thStyle}>heartbeat</th>
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
                        style={{ color: '#06c', textDecoration: 'none', fontWeight: 600 }}
                      >
                        {device.hostname ?? device.device_id}
                      </Link>
                    </td>
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
                    <td style={tdStyle}>{device.agent_version ?? '—'}</td>
                    <td style={tdStyle}>{device.os_version ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Recent messages</h3>
        {!recentMessages || recentMessages.length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>None.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>seq</th>
                <th style={thStyle}>direction</th>
                <th style={thStyle}>from</th>
                <th style={thStyle}>captured</th>
              </tr>
            </thead>
            <tbody>
              {recentMessages.map((m) => (
                <tr key={m.archive_seq} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace' }}>#{m.archive_seq}</td>
                  <td style={tdStyle}>{m.direction}</td>
                  <td style={tdStyle}>{m.from_handle}</td>
                  <td style={tdStyle}>{m.captured_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p style={{ color: '#666', fontSize: 12, marginTop: 32 }}>Signed in as {session.email}.</p>
    </div>
  );
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '6px 8px', verticalAlign: 'top' as const };

function VolumeCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: 12,
        background: '#fff',
        border: '1px solid #ddd',
        borderRadius: 6,
      }}
    >
      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#666' }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 700 }}>{value.toLocaleString()}</div>
    </div>
  );
}
