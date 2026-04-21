import { describe, expect, it } from 'vitest';
import { buildSearchSql } from './search';

function paramByName(params: readonly { name?: string | undefined }[], name: string) {
  return params.find((p) => p.name === name);
}

describe('buildSearchSql', () => {
  it('defaults filters to NULL (params opt out of WHERE clauses)', () => {
    const { sql, params, limit } = buildSearchSql('firm_testco1', {});
    expect(sql).toContain('FROM message_meta');
    expect(sql).toContain('ORDER BY archive_seq DESC');
    expect(limit).toBe(50);

    expect(paramByName(params, 'firm_id')).toMatchObject({
      value: { stringValue: 'firm_testco1' },
    });
    expect(paramByName(params, 'employee_id')).toMatchObject({
      value: { isNull: true },
    });
    expect(paramByName(params, 'q')).toMatchObject({ value: { isNull: true } });
    expect(paramByName(params, 'cursor')).toMatchObject({ value: { isNull: true } });
    // limit + 1 passed to SQL to detect next page.
    expect(paramByName(params, 'limit')).toMatchObject({ value: { longValue: 51 } });
  });

  it('binds employee_id when provided', () => {
    const { params } = buildSearchSql('firm_testco1', { employeeId: 'emp_jane42xx' });
    expect(paramByName(params, 'employee_id')).toMatchObject({
      value: { stringValue: 'emp_jane42xx' },
    });
  });

  it('trims and binds q; empty/whitespace passes NULL (no tsquery match)', () => {
    expect(
      paramByName(buildSearchSql('firm_testco1', { q: '  hello  ' }).params, 'q'),
    ).toMatchObject({ value: { stringValue: 'hello' } });
    expect(
      paramByName(buildSearchSql('firm_testco1', { q: '   ' }).params, 'q'),
    ).toMatchObject({ value: { isNull: true } });
  });

  it('caps limit at MAX_LIMIT and floors at 1', () => {
    expect(buildSearchSql('firm_testco1', { limit: 0 }).limit).toBe(1);
    expect(buildSearchSql('firm_testco1', { limit: 9_999 }).limit).toBe(200);
  });

  it('fetches limit + 1 to detect next page', () => {
    const { params } = buildSearchSql('firm_testco1', { limit: 25 });
    expect(paramByName(params, 'limit')).toMatchObject({ value: { longValue: 26 } });
  });

  it('passes cursor and from_ts/to_ts as the right Data API types', () => {
    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-04-30T23:59:59Z');
    const { params } = buildSearchSql('firm_testco1', { cursor: 12345, from, to });
    expect(paramByName(params, 'cursor')).toMatchObject({ value: { longValue: 12345 } });
    expect(paramByName(params, 'from_ts')).toMatchObject({
      typeHint: 'TIMESTAMP',
      value: { stringValue: '2026-04-01 00:00:00.000' },
    });
    expect(paramByName(params, 'to_ts')).toMatchObject({
      typeHint: 'TIMESTAMP',
      value: { stringValue: '2026-04-30 23:59:59.000' },
    });
  });
});
