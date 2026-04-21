import { execute, num, str, ts } from './db';
import { serverEnv } from './env';

export interface SearchFilters {
  employeeId?: string | null;
  q?: string | null;
  from?: Date | null;
  to?: Date | null;
  cursor?: number | null;
  limit?: number;
}

export interface SearchRow {
  archive_seq: number;
  message_id: string;
  employee_id: string;
  device_id: string;
  source: string;
  conversation_id: string;
  direction: string;
  from_handle: string;
  to_handles: string[];
  body_text: string;
  unsent: boolean;
  captured_at: string;
  ingested_at: string;
  s3_bucket: string;
  s3_key: string;
}

export interface SearchPage {
  rows: SearchRow[];
  nextCursor: number | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Build the parameterized SELECT. Pure; no DB access. Returns {sql, params}.
 *
 * Keyset pagination on archive_seq (DESC). Gaps in archive_seq are fine;
 * we order on it because it's monotonic per firm and unique. captured_at
 * would be more user-intuitive but can tie at sub-second precision, and
 * mixing keyset on (captured_at, archive_seq) adds complexity for little
 * MVP value.
 */
export function buildSearchSql(firmId: string, f: SearchFilters) {
  const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  // Fetch limit+1 to compute nextCursor without a separate count query.
  const fetchLimit = limit + 1;

  const sql = `
    SELECT
      archive_seq, message_id, employee_id, device_id, source,
      conversation_id, direction, from_handle, to_handles, body_text,
      unsent, captured_at, ingested_at, s3_bucket, s3_key
    FROM message_meta
    WHERE firm_id = :firm_id
      AND (CAST(:employee_id AS TEXT) IS NULL OR employee_id = :employee_id)
      AND (CAST(:q AS TEXT) IS NULL OR body_text_tsv @@ plainto_tsquery('english', :q))
      AND (CAST(:from_ts AS TIMESTAMPTZ) IS NULL OR captured_at >= :from_ts)
      AND (CAST(:to_ts AS TIMESTAMPTZ) IS NULL OR captured_at <= :to_ts)
      AND (CAST(:cursor AS BIGINT) IS NULL OR archive_seq < :cursor)
    ORDER BY archive_seq DESC
    LIMIT :limit
  `.trim();

  const params = [
    str('firm_id', firmId),
    str('employee_id', f.employeeId ?? null),
    str('q', f.q && f.q.trim().length > 0 ? f.q.trim() : null),
    ts('from_ts', f.from ?? null),
    ts('to_ts', f.to ?? null),
    num('cursor', f.cursor ?? null),
    num('limit', fetchLimit),
  ];
  return { sql, params, limit };
}

function rowFromDataApi(r: Record<string, unknown>): SearchRow {
  // Data API returns positional columns as "0", "1", ...; projection above
  // is the source of truth for indexes.
  const toHandlesStr = (r['8'] as string | null) ?? '{}';
  // Postgres text[] literal format: {"a","b"} or {a,b}. Strip braces and split.
  const trimmed = toHandlesStr.replace(/^\{|\}$/g, '');
  const toHandles = trimmed.length === 0
    ? []
    : trimmed
        .split(',')
        .map((s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"'));
  return {
    archive_seq: Number(r['0']),
    message_id: String(r['1']),
    employee_id: String(r['2']),
    device_id: String(r['3']),
    source: String(r['4']),
    conversation_id: String(r['5']),
    direction: String(r['6']),
    from_handle: String(r['7']),
    to_handles: toHandles,
    body_text: String(r['9'] ?? ''),
    unsent: Boolean(r['10']),
    captured_at: String(r['11']),
    ingested_at: String(r['12']),
    s3_bucket: String(r['13']),
    s3_key: String(r['14']),
  };
}

export async function searchMessages(f: SearchFilters): Promise<SearchPage> {
  const env = serverEnv();
  const { sql, params, limit } = buildSearchSql(env.FIRM_ID, f);
  const res = await execute(sql, params);
  const rows = res.rows.map(rowFromDataApi);
  let nextCursor: number | null = null;
  if (rows.length > limit) {
    const lastInPage = rows[limit - 1];
    if (lastInPage) nextCursor = lastInPage.archive_seq;
    rows.length = limit;
  }
  return { rows, nextCursor };
}
