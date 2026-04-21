import Link from 'next/link';
import { recordAudit } from '../../lib/audit';
import { requireSession } from '../../lib/auth';
import { serverConfig, serviceClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

export default async function EmployeesIndexPage() {
  const session = await requireSession();
  const cfg = serverConfig();
  const sb = serviceClient();

  const { data: employees, error } = await sb
    .from('employee')
    .select('employee_id, email, full_name, active, enrolled_at')
    .eq('firm_id', cfg.FIRM_ID)
    .order('full_name', { ascending: true });

  if (error) {
    return (
      <div>
        <h2>Employees</h2>
        <p style={{ color: '#a00' }}>Error loading employees: {error.message}</p>
      </div>
    );
  }

  // Count devices per employee in one query, then fold into rows.
  const { data: devices } = await sb
    .from('device')
    .select('employee_id, status, revoked_at, paused')
    .eq('firm_id', cfg.FIRM_ID);

  const byEmployee = new Map<string, { total: number; active: number }>();
  for (const d of devices ?? []) {
    const e = byEmployee.get(d.employee_id) ?? { total: 0, active: 0 };
    e.total += 1;
    if (!d.revoked_at && !d.paused) e.active += 1;
    byEmployee.set(d.employee_id, e);
  }

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'page_view',
    targetType: 'employees_index',
  });

  return (
    <div>
      <h2 style={{ margin: 0 }}>Employees</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
        {employees?.length ?? 0} employee(s) in {cfg.FIRM_ID}.
      </p>
      {(employees?.length ?? 0) === 0 ? (
        <p style={{ color: '#666' }}>None enrolled yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={thStyle}>name</th>
              <th style={thStyle}>email</th>
              <th style={thStyle}>id</th>
              <th style={thStyle}>active</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>devices</th>
            </tr>
          </thead>
          <tbody>
            {(employees ?? []).map((e) => {
              const stats = byEmployee.get(e.employee_id) ?? { total: 0, active: 0 };
              return (
                <tr key={e.employee_id} style={{ borderTop: '1px solid #eee' }}>
                  <td style={tdStyle}>
                    <Link
                      href={`/employees/${encodeURIComponent(e.employee_id)}`}
                      style={{ color: '#06c', textDecoration: 'none', fontWeight: 600 }}
                    >
                      {e.full_name}
                    </Link>
                  </td>
                  <td style={tdStyle}>{e.email}</td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{e.employee_id}</td>
                  <td style={tdStyle}>{e.active ? 'yes' : 'no'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {stats.active}/{stats.total}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '6px 8px', verticalAlign: 'top' as const };
