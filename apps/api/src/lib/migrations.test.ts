import { describe, expect, it, vi } from 'vitest';
import { applyMigrations, type MigrationRunnerDeps, splitStatements } from './migrations.js';

describe('splitStatements', () => {
  it('drops BEGIN/COMMIT and -- comments, splits on semicolons', () => {
    const sql = `
-- header comment
BEGIN;
CREATE TABLE t (id INT);
CREATE INDEX ON t (id);
COMMIT;
    `;
    expect(splitStatements(sql)).toEqual(['CREATE TABLE t (id INT)', 'CREATE INDEX ON t (id)']);
  });

  it('handles a trailing statement with no newline before semicolon', () => {
    expect(splitStatements('CREATE TABLE t (id INT);')).toEqual(['CREATE TABLE t (id INT)']);
  });

  it('strips inline -- comments', () => {
    expect(splitStatements('CREATE TABLE t (id INT); -- trailing')).toEqual([
      'CREATE TABLE t (id INT)',
    ]);
  });
});

describe('applyMigrations', () => {
  function makeDeps(already: string[]) {
    const txExecute = vi.fn(async (_sql: string) => ({ rows: [] as Record<string, unknown>[] }));
    const execute = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT name FROM schema_migrations')) {
        return { rows: already.map((n) => ({ '0': n }) as Record<string, unknown>) };
      }
      return { rows: [] as Record<string, unknown>[] };
    });
    let txCount = 0;
    const deps: MigrationRunnerDeps = {
      execute,
      withTx: async (fn) => {
        txCount += 1;
        return fn({ execute: txExecute });
      },
    };
    return { execute, txExecute, deps, txCount: () => txCount };
  }

  it('applies pending migrations and records them', async () => {
    const { deps, txExecute, txCount } = makeDeps([]);
    const res = await applyMigrations(deps, [
      { name: '001_init', sql: 'CREATE TABLE a (id INT); CREATE INDEX ON a (id);' },
      { name: '002_more', sql: 'CREATE TABLE b (id INT);' },
    ]);
    expect(res.appliedNow).toEqual(['001_init', '002_more']);
    expect(res.alreadyApplied).toEqual([]);
    expect(txCount()).toBe(2);

    const sqls = txExecute.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain('CREATE TABLE a (id INT)');
    expect(sqls).toContain('CREATE INDEX ON a (id)');
    expect(sqls).toContain('CREATE TABLE b (id INT)');
    expect(sqls.filter((s) => s.startsWith('INSERT INTO schema_migrations')).length).toBe(2);
  });

  it('skips already-applied migrations', async () => {
    const { deps, txCount } = makeDeps(['001_init']);
    const res = await applyMigrations(deps, [
      { name: '001_init', sql: 'CREATE TABLE a (id INT);' },
      { name: '002_more', sql: 'CREATE TABLE b (id INT);' },
    ]);
    expect(res.appliedNow).toEqual(['002_more']);
    expect(res.alreadyApplied).toEqual(['001_init']);
    expect(txCount()).toBe(1);
  });

  it('rolls back on statement failure (transaction semantics)', async () => {
    const { deps, txExecute } = makeDeps([]);
    let call = 0;
    txExecute.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('boom');
      return { rows: [] };
    });
    await expect(
      applyMigrations(deps, [
        { name: '001_bad', sql: 'CREATE TABLE a (id INT); CREATE TABLE b (id INT);' },
      ]),
    ).rejects.toThrow(/boom/);
  });

  it('rejects a migration that splits to zero statements', async () => {
    const { deps } = makeDeps([]);
    await expect(
      applyMigrations(deps, [{ name: '001_empty', sql: '-- only comments\n' }]),
    ).rejects.toThrow(/no statements/);
  });
});
