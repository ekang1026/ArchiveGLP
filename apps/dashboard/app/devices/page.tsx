import { requireSession } from '../../lib/auth';
import { serviceClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

export default async function DevicesPage() {
  const session = await requireSession();
  const sb = serviceClient();
  const { data: devices, error } = await sb
    .from('device')
    .select(
      'device_id, employee_id, status, last_heartbeat_at, queue_depth, os_version, agent_version',
    )
    .order('last_heartbeat_at', { ascending: true, nullsFirst: true });

  if (error) {
    return (
      <div>
        <h2>Device health</h2>
        <p style={{ color: '#a00' }}>
          Error loading devices: {error.message}
        </p>
      </div>
    );
  }
  const rows = devices ?? [];

  return (
    <div>
      <h2>Device health</h2>
      <p style={{ color: '#666' }}>
        {rows.length} device(s). Live heartbeat / silent detection / command UI
        not yet wired — see SUPABASE_SETUP.md "next slice".
      </p>
      {rows.length === 0 ? (
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
              <th style={{ textAlign: 'left' }}>agent</th>
              <th style={{ textAlign: 'left' }}>os</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.device_id} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ fontFamily: 'monospace' }}>{d.device_id}</td>
                <td>{d.employee_id}</td>
                <td>{d.status}</td>
                <td>{d.last_heartbeat_at ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{d.queue_depth}</td>
                <td>{d.agent_version ?? '—'}</td>
                <td>{d.os_version ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ color: '#666', fontSize: 12, marginTop: 24 }}>
        Signed in as {session.email}.
      </p>
    </div>
  );
}
