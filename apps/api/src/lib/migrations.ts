/**
 * Forward-only SQL migrations.
 *
 * Each migration is:
 *  - Wrapped by the runner in a single RDS Data API transaction.
 *  - Recorded in ``schema_migrations`` on success; skipped if already present.
 *
 * Migration files use PostgreSQL syntax and may include ``BEGIN;``/``COMMIT;``
 * for local-tool compatibility (psql). The splitter strips them because the
 * Data API opens its own transaction.
 */

export interface Migration {
  name: string;
  sql: string;
}

/**
 * Split a .sql file into individual statements safely enough for our
 * hand-written migrations. Not a general-purpose SQL parser:
 *  - Strips full-line comments (``-- ...``).
 *  - Drops lines that are just ``BEGIN;`` or ``COMMIT;``.
 *  - Splits on ``;``.
 *
 * We write migrations to be compatible with this splitter; if we ever need
 * triggers or functions with embedded semicolons we'll upgrade the splitter
 * rather than complicate every migration.
 */
export function splitStatements(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, '');
  const noBeginCommit = noComments
    .split('\n')
    .filter((line) => !/^\s*(BEGIN|COMMIT)\s*;?\s*$/i.test(line))
    .join('\n');
  return noBeginCommit
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface MigrationExecutor {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface MigrationRunnerDeps extends MigrationExecutor {
  withTx<T>(fn: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}

const ENSURE_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
`;

export interface ApplyResult {
  appliedNow: string[];
  alreadyApplied: string[];
}

/**
 * Apply every migration in order. Idempotent: migrations already recorded
 * in ``schema_migrations`` are skipped.
 */
export async function applyMigrations(
  deps: MigrationRunnerDeps,
  migrations: readonly Migration[],
): Promise<ApplyResult> {
  await deps.execute(ENSURE_TABLE);
  const existing = await deps.execute('SELECT name FROM schema_migrations');
  const already = new Set(existing.rows.map((r) => String(r['0'])));
  const appliedNow: string[] = [];
  const alreadyApplied: string[] = [];

  for (const m of migrations) {
    if (already.has(m.name)) {
      alreadyApplied.push(m.name);
      continue;
    }
    const statements = splitStatements(m.sql);
    if (statements.length === 0) {
      throw new Error(`migration ${m.name} has no statements`);
    }
    await deps.withTx(async (tx) => {
      for (const stmt of statements) {
        await tx.execute(stmt);
      }
      // Use a string literal for the name since Data API parameter binding
      // for simple schema_migrations insert is overkill and controlled input.
      await tx.execute(
        `INSERT INTO schema_migrations (name) VALUES ('${m.name.replace(/'/g, "''")}')`,
      );
    });
    appliedNow.push(m.name);
  }

  return { appliedNow, alreadyApplied };
}
