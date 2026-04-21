import { searchMessages } from '../../lib/search';

interface PageProps {
  searchParams: Promise<{ q?: string; employee?: string }>;
}

/**
 * MVP search page. The `searchMessages` call is a stub that returns [] until
 * the metadata DB and query layer land. The form + URL state + audit-log hook
 * are in place so the UI can be wired through in one go later.
 */
export default async function MessagesPage({ searchParams }: PageProps) {
  const { q, employee } = await searchParams;
  const results = await searchMessages({ q, employee });

  return (
    <div>
      <h2>Messages</h2>
      <form style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input name="employee" placeholder="employee_id" defaultValue={employee} />
        <input name="q" placeholder="text contains" defaultValue={q} style={{ flex: 1 }} />
        <button type="submit">Search</button>
      </form>
      {results.length === 0 ? (
        <p style={{ color: '#666' }}>No results (metadata DB not yet wired).</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>When</th>
              <th style={{ textAlign: 'left' }}>Employee</th>
              <th style={{ textAlign: 'left' }}>From</th>
              <th style={{ textAlign: 'left' }}>To</th>
              <th style={{ textAlign: 'left' }}>Text</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.message_id} style={{ borderTop: '1px solid #eee' }}>
                <td>{r.captured_at}</td>
                <td>{r.employee_id}</td>
                <td>{r.from.handle}</td>
                <td>{r.to.map((t) => t.handle).join(', ')}</td>
                <td>{r.body_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
