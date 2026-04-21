import { requireSession } from '../../lib/auth';
import { recordAudit } from '../../lib/audit';
import { searchMessages } from '../../lib/search';

interface PageProps {
  searchParams: Promise<{
    q?: string;
    employee?: string;
    from?: string;
    to?: string;
    cursor?: string;
  }>;
}

function parseDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default async function MessagesPage({ searchParams }: PageProps) {
  const session = await requireSession();
  const { q, employee, from, to, cursor } = await searchParams;

  const filters = {
    q: q ?? null,
    employeeId: employee ?? null,
    from: parseDate(from),
    to: parseDate(to),
    cursor: cursor ? Number(cursor) : null,
  };

  const page = await searchMessages(filters);

  // Every search is auditable. Metadata captures the filter so a
  // supervisor's query history is reproducible.
  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'messages_search',
    metadata: {
      q: q ?? null,
      employee_id: employee ?? null,
      from: from ?? null,
      to: to ?? null,
      cursor: cursor ?? null,
      result_count: page.rows.length,
    },
  });

  return (
    <div>
      <h2>Messages</h2>
      <form style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <input name="employee" placeholder="employee_id" defaultValue={employee} />
        <input name="from" type="datetime-local" defaultValue={from} title="from" />
        <input name="to" type="datetime-local" defaultValue={to} title="to" />
        <input
          name="q"
          placeholder="text contains"
          defaultValue={q}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button type="submit">Search</button>
      </form>

      {page.rows.length === 0 ? (
        <p style={{ color: '#666' }}>No results.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>seq</th>
              <th style={{ textAlign: 'left' }}>captured</th>
              <th style={{ textAlign: 'left' }}>employee</th>
              <th style={{ textAlign: 'left' }}>dir</th>
              <th style={{ textAlign: 'left' }}>from</th>
              <th style={{ textAlign: 'left' }}>to</th>
              <th style={{ textAlign: 'left' }}>text</th>
            </tr>
          </thead>
          <tbody>
            {page.rows.map((r) => (
              <tr key={r.archive_seq} style={{ borderTop: '1px solid #eee' }}>
                <td style={{ fontFamily: 'monospace' }}>{r.archive_seq}</td>
                <td style={{ fontFamily: 'monospace' }}>{r.captured_at}</td>
                <td>{r.employee_id}</td>
                <td>{r.direction}</td>
                <td>{r.from_handle}</td>
                <td>{r.to_handles.join(', ')}</td>
                <td>
                  {r.unsent ? <em style={{ color: '#a00' }}>[unsent] </em> : null}
                  {r.body_text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {page.nextCursor !== null ? (
        <form style={{ marginTop: 20 }}>
          {employee ? <input type="hidden" name="employee" value={employee} /> : null}
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {from ? <input type="hidden" name="from" value={from} /> : null}
          {to ? <input type="hidden" name="to" value={to} /> : null}
          <input type="hidden" name="cursor" value={page.nextCursor} />
          <button type="submit">Next page</button>
        </form>
      ) : null}

      <p style={{ color: '#666', fontSize: 12, marginTop: 24 }}>
        Every search is recorded to the firm's audit log under SEC 17a-4(b)(4).
        Signed in as {session.email}.
      </p>
    </div>
  );
}
