import Link from 'next/link';
import { recordAudit } from '../../lib/audit';
import { requireSession } from '../../lib/auth';
import { serverConfig, serviceClient } from '../../lib/supabase';

export const dynamic = 'force-dynamic';

interface SearchParams {
  actor?: string;
  action?: string;
  target?: string;
  since?: string;
  until?: string;
  limit?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * /audit — supervisor-visible audit trail.
 *
 * Renders server-side from audit_log. Filters compose (AND) across
 * actor, action, target, and an [since, until) timestamp window.
 * Read-only by design: audit records cannot be edited or deleted
 * from this screen (or anywhere else in the dashboard — tier-2
 * compliance moves these rows into S3 Object Lock for WORM storage).
 */
export default async function AuditPage({ searchParams }: PageProps) {
  const session = await requireSession();
  const sp = await searchParams;

  const cfg = serverConfig();
  const sb = serviceClient();

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.parseInt(sp.limit ?? '', 10) || DEFAULT_LIMIT),
  );

  let q = sb
    .from('audit_log')
    .select(
      'audit_seq, actor_type, actor_id, action, target_type, target_id, metadata, occurred_at',
      { count: 'exact' },
    )
    .eq('firm_id', cfg.FIRM_ID)
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (sp.actor) q = q.ilike('actor_id', `%${sp.actor}%`);
  if (sp.action) q = q.eq('action', sp.action);
  if (sp.target) q = q.ilike('target_id', `%${sp.target}%`);
  if (sp.since) q = q.gte('occurred_at', sp.since);
  if (sp.until) q = q.lt('occurred_at', sp.until);

  const { data: rows, count, error } = await q;

  await recordAudit({
    actorType: 'supervisor',
    actorId: session.email,
    action: 'page_view',
    targetType: 'page',
    targetId: '/audit',
    metadata: {
      filters: {
        actor: sp.actor ?? null,
        action: sp.action ?? null,
        target: sp.target ?? null,
        since: sp.since ?? null,
        until: sp.until ?? null,
      },
    },
  });

  return (
    <div>
      <h2 style={{ margin: '0 0 4px 0' }}>Audit log</h2>
      <p style={{ color: '#666', fontSize: 13, marginTop: 0 }}>
        Every supervisor action — page view, message export, device command,
        stepup attempt — is recorded here. Rows are append-only.
      </p>

      <form
        method="get"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 8,
          marginTop: 12,
          marginBottom: 16,
          padding: 12,
          background: '#f9fafb',
          border: '1px solid #e5e7eb',
          borderRadius: 4,
        }}
      >
        <Field label="Actor contains" name="actor" value={sp.actor} />
        <Field label="Action (exact)" name="action" value={sp.action} />
        <Field label="Target contains" name="target" value={sp.target} />
        <Field label="Since (ISO)" name="since" value={sp.since} placeholder="2026-04-21T00:00:00Z" />
        <Field label="Until (ISO)" name="until" value={sp.until} placeholder="2026-04-22T00:00:00Z" />
        <Field label={`Limit (max ${MAX_LIMIT})`} name="limit" value={sp.limit} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <button
            type="submit"
            style={{
              padding: '6px 14px',
              border: '1px solid #2563eb',
              background: '#2563eb',
              color: '#fff',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            Filter
          </button>
          <Link
            href="/audit"
            style={{
              padding: '6px 12px',
              border: '1px solid #d1d5db',
              borderRadius: 4,
              color: '#222',
              textDecoration: 'none',
              fontSize: 13,
            }}
          >
            Reset
          </Link>
        </div>
      </form>

      {error ? (
        <p style={{ color: '#a00' }}>Error loading audit log: {error.message}</p>
      ) : (
        <>
          <p style={{ color: '#666', fontSize: 12 }}>
            Showing {rows?.length ?? 0} of {count ?? 0} matching rows.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thStyle}>occurred</th>
                <th style={thStyle}>actor</th>
                <th style={thStyle}>action</th>
                <th style={thStyle}>target</th>
                <th style={thStyle}>metadata</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr
                  key={String(r.audit_seq)}
                  style={{ borderTop: '1px solid #eee', verticalAlign: 'top' }}
                >
                  <td style={tdStyle}>{r.occurred_at}</td>
                  <td style={tdStyle}>
                    <div>{r.actor_id}</div>
                    <div style={{ color: '#888', fontSize: 11 }}>{r.actor_type}</div>
                  </td>
                  <td style={tdStyle}>{r.action}</td>
                  <td style={tdStyle}>
                    {r.target_type ? (
                      <>
                        <div>{r.target_id}</div>
                        <div style={{ color: '#888', fontSize: 11 }}>{r.target_type}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>
                    {r.metadata && Object.keys(r.metadata).length > 0
                      ? JSON.stringify(r.metadata)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p style={{ color: '#666', fontSize: 12, marginTop: 32 }}>Signed in as {session.email}.</p>
    </div>
  );
}

const thStyle = { textAlign: 'left' as const, padding: '4px 8px', color: '#444' };
const tdStyle = { padding: '4px 8px' };

function Field({
  label,
  name,
  value,
  placeholder,
}: {
  label: string;
  name: string;
  value?: string | undefined;
  placeholder?: string | undefined;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
      <span style={{ color: '#444' }}>{label}</span>
      <input
        type="text"
        name={name}
        defaultValue={value ?? ''}
        placeholder={placeholder}
        style={{
          padding: '4px 6px',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          fontSize: 13,
        }}
      />
    </label>
  );
}
