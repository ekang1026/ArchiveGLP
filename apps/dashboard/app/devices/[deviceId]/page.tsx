import Link from 'next/link';
import { notFound } from 'next/navigation';
import { recordAudit } from '../../../lib/audit';
import { requireSession } from '../../../lib/auth';
import { HEALTH_COLORS, computeHealth, formatAge } from '../../../lib/health';
import { serverConfig, serviceClient } from '../../../lib/supabase';
import { RemediationPanel } from './RemediationPanel';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ deviceId: string }>;
}

export default async function DevicePage({ params }: PageProps) {
  const session = await requireSession();
  const { deviceId } = await params;
  const cfg = serverConfig();
  const sb = serviceClient();

  const { data: device, error: devErr } = await sb
    .from('device')
    .select(
      'device_id, firm_id, employee_id, hostname, os_version, agent_version, uptime_seconds, disk_free_gb, memory_free_mb, messages_app_running, fda_status, enrolled_at, last_heartbeat_at, last_captured_at, status, queue_depth, clock_skew_ms, paused, revoked_at',
    )
    .eq('firm_id', cfg.FIRM_ID)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (devErr) {
    return (
      <div>
        <h2>Device</h2>
        <p style={{ color: '#a00' }}>Error loading device: {devErr.message}</p>
      </div>
    );
  }
  if (!device) notFound();

  // Parallelize the three follow-up queries. None depend on each other.
  const [{ data: employee }, { data: commands }, { data: recentMessages, count: messageCount }] =
    await Promise.all([
      sb
        .from('employee')
        .select('employee_id, email, full_name, active')
        .eq('employee_id', device.employee_id)
        .maybeSingle(),
      sb
        .from('pending_command')
        .select(
          'command_id, action, issued_by, issued_at, delivered_at, completed_at, error, result',
        )
        .eq('device_id', deviceId)
        .order('issued_at', { ascending: false })
        .limit(20),
      sb
        .from('message_meta')
        .select('archive_seq, direction, captured_at', { count: 'exact', head: false })
        .eq('device_id', deviceId)
        .order('captured_at', { ascending: false })
        .limit(5),
    ]);

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'page_view',
    targetType: 'device',
    targetId: deviceId,
  });

  const health = computeHealth(device);
  const color = HEALTH_COLORS[health.level];

  return (
    <div>
      <nav style={{ fontSize: 13, marginBottom: 12 }}>
        <Link href="/devices" style={{ color: '#06c' }}>
          ← All devices
        </Link>
      </nav>
      <h2 style={{ margin: 0 }}>{device.hostname ?? device.device_id}</h2>
      <div style={{ color: '#666', fontSize: 13, marginTop: 4, fontFamily: 'monospace' }}>
        {device.device_id}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            background: color.bg,
            color: color.fg,
            border: `1px solid ${color.border}`,
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
          }}
        >
          {health.level}
        </span>
        <span style={{ color: '#666', fontSize: 13 }}>{health.reasons.join(' · ')}</span>
      </div>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Machine</h3>
        <KVGrid
          rows={[
            ['Hostname', device.hostname ?? '—'],
            ['macOS version', device.os_version ?? '—'],
            ['Agent version', device.agent_version ?? '—'],
            ['Uptime', device.uptime_seconds ? formatAge(Number(device.uptime_seconds)) : '—'],
            [
              'Disk free',
              device.disk_free_gb !== null && device.disk_free_gb !== undefined
                ? `${Number(device.disk_free_gb).toFixed(1)} GB`
                : '—',
            ],
            [
              'Memory free',
              device.memory_free_mb !== null && device.memory_free_mb !== undefined
                ? `${Number(device.memory_free_mb)} MB`
                : '—',
            ],
            [
              'Messages.app',
              device.messages_app_running === null
                ? '—'
                : device.messages_app_running
                  ? 'running'
                  : 'NOT running',
            ],
            ['Full Disk Access', device.fda_status ?? '—'],
            [
              'Clock skew',
              device.clock_skew_ms !== null && device.clock_skew_ms !== undefined
                ? `${device.clock_skew_ms} ms`
                : '—',
            ],
          ]}
        />
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Archive</h3>
        <KVGrid
          rows={[
            ['Status', device.status],
            ['Paused', device.paused ? 'yes' : 'no'],
            ['Revoked', device.revoked_at ? device.revoked_at : 'no'],
            ['Queue depth', String(device.queue_depth ?? 0)],
            [
              'Last heartbeat',
              device.last_heartbeat_at
                ? `${device.last_heartbeat_at} (${health.heartbeat_age_seconds !== null ? `${formatAge(health.heartbeat_age_seconds)} ago` : '—'})`
                : 'never',
            ],
            ['Last message captured', device.last_captured_at ?? 'never'],
            ['Enrolled at', device.enrolled_at],
            ['Total messages (recent)', `${messageCount ?? 0}+`],
          ]}
        />
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Employee</h3>
        {employee ? (
          <KVGrid
            rows={[
              ['Name', employee.full_name],
              ['Email', employee.email],
              ['ID', employee.employee_id],
              ['Active', employee.active ? 'yes' : 'no'],
            ]}
          />
        ) : (
          <p style={{ color: '#a00', fontSize: 13 }}>Employee record missing.</p>
        )}
      </section>

      <RemediationPanel
        deviceId={device.device_id}
        paused={Boolean(device.paused)}
        revoked={Boolean(device.revoked_at)}
      />

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Recent commands</h3>
        {!commands || commands.length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>None.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>action</th>
                <th style={thStyle}>issued by</th>
                <th style={thStyle}>issued</th>
                <th style={thStyle}>delivered</th>
                <th style={thStyle}>completed</th>
                <th style={thStyle}>result</th>
              </tr>
            </thead>
            <tbody>
              {commands.map((c) => (
                <tr key={c.command_id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={tdStyle}>{c.action}</td>
                  <td style={tdStyle}>{c.issued_by}</td>
                  <td style={tdStyle}>{c.issued_at}</td>
                  <td style={tdStyle}>{c.delivered_at ?? '—'}</td>
                  <td style={tdStyle}>
                    {c.completed_at ?? (c.delivered_at ? 'in-flight' : 'queued')}
                  </td>
                  <td style={{ ...tdStyle, color: c.error ? '#9a1c1c' : '#222' }}>
                    {c.error ? c.error : c.result ? JSON.stringify(c.result) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: '0 0 8px 0' }}>Recent captures</h3>
        {!recentMessages || recentMessages.length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>None.</p>
        ) : (
          <ul style={{ fontSize: 13, margin: 0, paddingLeft: 18 }}>
            {recentMessages.map((m) => (
              <li key={m.archive_seq}>
                #{m.archive_seq} {m.direction} at {m.captured_at}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ color: '#666', fontSize: 12, marginTop: 32 }}>Signed in as {session.email}.</p>
    </div>
  );
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '4px 8px', verticalAlign: 'top' as const };

function KVGrid({ rows }: { rows: [string, string][] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr',
        gap: '4px 12px',
        margin: 0,
        fontSize: 13,
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt style={{ color: '#666' }}>{k}</dt>
          <dd style={{ margin: 0 }}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
