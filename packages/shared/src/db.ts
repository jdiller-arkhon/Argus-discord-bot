import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface Migration {
  /** Monotonically increasing, starting at 1. Stored in `PRAGMA user_version`. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Opens (creating if needed) a SQLite database and applies any migrations
 * newer than the stored `user_version`, each inside its own transaction.
 * Pass `':memory:'` for an in-memory database.
 */
export function openDatabase(path: string, migrations: readonly Migration[]): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, migrations);
  return db;
}

export function migrate(db: Db, migrations: readonly Migration[]): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`Migration versions must be contiguous from 1; got ${migration.version} at position ${index + 1}`);
    }
  });

  const current = db.pragma('user_version', { simple: true }) as number;
  for (const migration of sorted) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

/**
 * Records that a scheduled job ran for a given key (e.g. `preflight:2026-10-09`).
 * Returns false if it had already been recorded, so callers can skip duplicates
 * across restarts. Requires the `job_runs` table from {@link jobRunsMigrationSql}.
 */
export function claimJobRun(db: Db, job: string, runKey: string, now: Date = new Date()): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO job_runs (job, run_key, ran_at) VALUES (?, ?, ?)')
    .run(job, runKey, now.toISOString());
  return result.changes === 1;
}

export function releaseJobRun(db: Db, job: string, runKey: string): void {
  db.prepare('DELETE FROM job_runs WHERE job = ? AND run_key = ?').run(job, runKey);
}

/** Adapts {@link claimJobRun}/{@link releaseJobRun} to the scheduler's store interface. */
export function sqliteJobRunStore(db: Db): { claim(job: string, runKey: string): boolean; release(job: string, runKey: string): void } {
  return {
    claim: (job, runKey) => claimJobRun(db, job, runKey),
    release: (job, runKey) => releaseJobRun(db, job, runKey),
  };
}

export function hasJobRun(db: Db, job: string, runKey: string): boolean {
  return db.prepare('SELECT 1 FROM job_runs WHERE job = ? AND run_key = ?').get(job, runKey) !== undefined;
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
