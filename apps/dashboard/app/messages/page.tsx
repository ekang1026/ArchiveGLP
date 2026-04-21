import Link from 'next/link';
import { recordAudit } from '../../lib/audit';
import { requireSession } from '../../lib/auth';
import { serverConfig, serviceClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface SearchParams {
  q?: string;
  employee?: string;
  device?: string;
  page?: string;
}

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const employeeId = (params.employee ?? '').trim();
  const deviceId = (params.device ?? '').trim();
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const cfg = serverConfig();
  const sb = serviceClient();

  let query = sb
    .from('message_meta')
    .select(
      'archive_seq, message_id, employee_id, device_id, direction, from_handle, to_handles, body_text, unsent, captured_at',
      { count: 'exact' },
    )
    .eq('firm_id', cfg.FIRM_ID)
    .order('captured_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (employeeId) query = query.eq('employee_id', employeeId);
  if (deviceId) query = query.eq('device_id', deviceId);
  if (q) query = query.textSearch('body_text_tsv', q, { type: 'websearch' });

  const { data: rows, count, error } = await query;

  const isSearch = Boolean(q || employeeId || deviceId);
  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: isSearch ? 'messages_search' : 'page_view',
    targetType: isSearch ? 'message_meta' : 'page',
    targetId: isSearch ? null : '/messages',
    metadata: {
      q: q || null,
      employee_id: employeeId || null,
      device_id: deviceId || null,
      page,
    },
  });

  const total = count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h2 style={{ margin: 0 }}>Messages</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 4 }}>
        Captured iMessage / SMS for {cfg.FIRM_ID}. All searches are logged to the audit trail.
      </p>

      <form
        method="get"
        style={{
          marginTop: 16,
          display: 'grid',
          gridTemplateColumns: '1fr 180px 180px auto',
          gap: 8,
          alignItems: 'end',
        }}
      >
        <Field
          label="Search (full-text)"
          name="q"
          defaultValue={q}
          placeholder="e.g. wire transfer"
        />
        <Field
          label="Employee ID"
          name="employee"
          defaultValue={employeeId}
          placeholder="emp_..."
        />
        <Field label="Device ID" name="device" defaultValue={deviceId} placeholder="dev_..." />
        <button
          type="submit"
          style={{
            padding: '8px 14px',
            background: '#111',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Search
        </button>
      </form>

      {error ? (
        <p style={{ color: '#a00', marginTop: 16 }}>Error loading messages: {error.message}</p>
      ) : (rows?.length ?? 0) === 0 ? (
        <p style={{ color: '#666', marginTop: 16 }}>
          No messages match. {isSearch ? 'Try a broader search.' : 'Nothing captured yet.'}
        </p>
      ) : (
        <>
          <p style={{ color: '#666', fontSize: 12, marginTop: 16 }}>
            {total.toLocaleString()} match{total === 1 ? '' : 'es'} · page {page} of {pageCount}
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
            <thead>
              <tr>
                <th style={thStyle}>#</th>
                <th style={thStyle}>captured</th>
                <th style={thStyle}>dir</th>
                <th style={thStyle}>from</th>
                <th style={thStyle}>to</th>
                <th style={thStyle}>body</th>
                <th style={thStyle}>employee</th>
                <th style={thStyle}>device</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((m) => (
                <tr key={m.archive_seq} style={{ borderTop: '1px solid #eee' }}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace' }}>{m.archive_seq}</td>
                  <td style={tdStyle}>{m.captured_at}</td>
                  <td style={tdStyle}>
                    <DirBadge direction={m.direction} />
                  </td>
                  <td style={tdStyle}>{m.from_handle}</td>
                  <td style={tdStyle}>{(m.to_handles ?? []).join(', ')}</td>
                  <td style={{ ...tdStyle, maxWidth: 420 }}>
                    <span style={{ color: m.unsent ? '#a00' : '#222' }}>
                      {truncate(m.body_text, 200)}
                    </span>
                    {m.unsent ? (
                      <span style={{ marginLeft: 6, color: '#a00', fontSize: 11 }}>(unsent)</span>
                    ) : null}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace' }}>
                    <Link
                      href={`/employees/${encodeURIComponent(m.employee_id)}`}
                      style={{ color: '#06c', textDecoration: 'none' }}
                    >
                      {m.employee_id}
                    </Link>
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace' }}>
                    <Link
                      href={`/devices/${encodeURIComponent(m.device_id)}`}
                      style={{ color: '#06c', textDecoration: 'none' }}
                    >
                      {m.device_id}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            page={page}
            pageCount={pageCount}
            params={{ q, employee: employeeId, device: deviceId }}
          />
        </>
      )}

      <p style={{ color: '#666', fontSize: 12, marginTop: 32 }}>Signed in as {session.email}.</p>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string;
  placeholder?: string;
}) {
  return (
    <label
      style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: '#444' }}
    >
      {label}
      <input
        type="text"
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        style={{
          padding: '6px 8px',
          fontSize: 13,
          border: '1px solid #ccc',
          borderRadius: 4,
        }}
      />
    </label>
  );
}

function DirBadge({ direction }: { direction: string }) {
  const isIn = direction === 'in';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        background: isIn ? '#e7f0ff' : '#eef7ea',
        color: isIn ? '#064' : '#264',
        border: `1px solid ${isIn ? '#bcd' : '#bdc'}`,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {direction}
    </span>
  );
}

function Pagination({
  page,
  pageCount,
  params,
}: {
  page: number;
  pageCount: number;
  params: { q: string; employee: string; device: string };
}) {
  if (pageCount <= 1) return null;
  const mk = (p: number) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.employee) qs.set('employee', params.employee);
    if (params.device) qs.set('device', params.device);
    qs.set('page', String(p));
    return `/messages?${qs.toString()}`;
  };
  return (
    <div style={{ marginTop: 12, display: 'flex', gap: 12, fontSize: 13 }}>
      {page > 1 ? (
        <Link href={mk(page - 1)} style={{ color: '#06c' }}>
          ← prev
        </Link>
      ) : (
        <span style={{ color: '#bbb' }}>← prev</span>
      )}
      <span style={{ color: '#666' }}>
        page {page} of {pageCount}
      </span>
      {page < pageCount ? (
        <Link href={mk(page + 1)} style={{ color: '#06c' }}>
          next →
        </Link>
      ) : (
        <span style={{ color: '#bbb' }}>next →</span>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '6px 8px', verticalAlign: 'top' as const };
