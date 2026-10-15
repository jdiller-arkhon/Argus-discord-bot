/**
 * The bots' database interface. Two implementations:
 * - `openSqliteDb` (./sqlite.ts): a local SQLite file, or `:memory:` in tests;
 * - `createD1BridgeDb` (./d1-bridge.ts): Cloudflare D1, reached from the bot's container through
 *   its Worker.
 *
 * Every call is async because D1 is. Runtime-neutral: no Node or Workers APIs.
 */

export type SqlValue = string | number | null;

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

export interface RunResult {
  /** Rows inserted, updated or deleted. */
  changes: number;
  /** Row id of the last INSERT, when there was one. */
  lastRowId: number | null;
}

export interface SqlDb {
  /** The first row, or undefined when there is none. */
  get<T>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  run(sql: string, ...params: SqlValue[]): Promise<RunResult>;
  /** Runs the statements in one transaction: all of them apply, or none. */
  batch(statements: readonly SqlStatement[]): Promise<RunResult[]>;
  close(): Promise<void>;
}

/** Builds a statement for {@link SqlDb.batch}. */
export function stmt(sql: string, ...params: SqlValue[]): SqlStatement {
  return { sql, params };
}

export interface Migration {
  /** Contiguous from 1. Recorded in `schema_migrations`. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Splits a migration into statements: drops `--` comment lines and splits on semicolons that end
 * a line. D1 runs one statement at a time.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (/^\s*--/.test(line)) continue;
    current.push(line);
    if (/;\s*$/.test(line)) {
      const statement = current.join('\n').trim().replace(/;\s*$/, '');
      if (statement) statements.push(statement);
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest) statements.push(rest);
  return statements;
}

/**
 * Applies migrations newer than the last recorded one. Each migration runs as one batch together
 * with its `schema_migrations` row, so it applies completely or not at all. Returns the versions
 * applied.
 */
export async function migrate(db: SqlDb, migrations: readonly Migration[]): Promise<number[]> {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration versions must be contiguous from 1; got ${migration.version} at position ${index + 1}`);
    }
  });

  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const row = await db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  const current = row?.v ?? 0;

  const applied: number[] = [];
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    await db.batch([
      ...splitStatements(migration.sql).map((sql) => stmt(sql)),
      stmt(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        migration.version,
        migration.name,
        new Date().toISOString(),
      ),
    ]);
    applied.push(migration.version);
  }
  return applied;
}

/**
 * Records that a scheduled job ran for a given key (e.g. `prune:2026-10-09`). Returns false if it
 * had already been recorded, so a run is not repeated after a restart. Needs the `job_runs` table
 * from {@link jobRunsMigrationSql}.
 */
export async function claimJobRun(db: SqlDb, job: string, runKey: string, now: Date = new Date()): Promise<boolean> {
  const result = await db.run(
    'INSERT OR IGNORE INTO job_runs (job, run_key, ran_at) VALUES (?, ?, ?)',
    job,
    runKey,
    now.toISOString(),
  );
  return result.changes === 1;
}

export async function releaseJobRun(db: SqlDb, job: string, runKey: string): Promise<void> {
  await db.run('DELETE FROM job_runs WHERE job = ? AND run_key = ?', job, runKey);
}

/** Adapts {@link claimJobRun}/{@link releaseJobRun} to the scheduler's store interface. */
export function sqlJobRunStore(db: SqlDb): {
  claim(job: string, runKey: string): Promise<boolean>;
  release(job: string, runKey: string): Promise<void>;
} {
  return {
    claim: (job, runKey) => claimJobRun(db, job, runKey),
    release: (job, runKey) => releaseJobRun(db, job, runKey),
  };
}

/** Include in a bot's migrations to enable {@link claimJobRun}. */
export const jobRunsMigrationSql = `
CREATE TABLE job_runs (
  job TEXT NOT NULL,
  run_key TEXT NOT NULL,
  ran_at TEXT NOT NULL,
  PRIMARY KEY (job, run_key)
);
`;
