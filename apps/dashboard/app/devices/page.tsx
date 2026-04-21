import { recordAudit } from '../../lib/audit';
import { requireSession } from '../../lib/auth';
import { type DeviceHealth, listDeviceHealth } from '../../lib/devices';

export const dynamic = 'force-dynamic';

function formatSilent(d: DeviceHealth): string {
  if (d.silent_seconds === null) return 'no heartbeat yet';
  const s = d.silent_seconds;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function DevicesPage() {
  const session = await requireSession();
  const devices = await listDeviceHealth();

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'device_list_view',
    metadata: { device_count: devices.length },
  });

  const silentCount = devices.filter((d) => d.is_silent).length;

  return (
    <div>
      <h2>Device health</h2>
      <p style={{ color: silentCount > 0 ? '#a00' : '#666' }}>
        {devices.length} device(s), {silentCount} silent or degraded.
      </p>

      {devices.length === 0 ? (
        <p style={{ color: '#666' }}>No devices enrolled.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>device</th>
              <th style={{ textAlign: 'left' }}>employee</th>
              <th style={{ textAlign: 'left' }}>status</th>
              <th style={{ textAlign: 'left' }}>last heartbeat</th>
              <th style={{ textAlign: 'right' }}>queue</th>
              <th style={{ textAlign: 'right' }}>skew</th>
              <th style={{ textAlign: 'left' }}>agent</th>
              <th style={{ textAlign: 'left' }}>os</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr
                key={d.device_id}
                style={{
                  borderTop: '1px solid #eee',
                  background: d.is_silent ? '#fff6f6' : undefined,
                }}
              >
                <td style={{ fontFamily: 'monospace' }}>{d.device_id}</td>
                <td>{d.employee_id}</td>
                <td style={{ color: d.is_silent ? '#a00' : '#060' }}>{d.status}</td>
                <td>{formatSilent(d)}</td>
                <td style={{ textAlign: 'right' }}>{d.queue_depth}</td>
                <td style={{ textAlign: 'right' }}>{d.clock_skew_ms}ms</td>
                <td>{d.agent_version ?? '—'}</td>
                <td>{d.os_version ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ color: '#666', fontSize: 12, marginTop: 24 }}>
        Silent threshold: 5 minutes. Signed in as {session.email}.
      </p>
    </div>
  );
}
