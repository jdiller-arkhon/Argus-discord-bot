import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { type Migration, migrate, type RunResult, type SqlDb, type SqlValue } from './sql.js';

/**
 * A {@link SqlDb} over a local SQLite file (or `':memory:'`), for running the bot outside
 * Cloudflare and for tests. Node only.
 */
export function createSqliteDb(path: string): SqlDb {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const toResult = (result: Database.RunResult): RunResult => ({
    changes: result.changes,
    lastRowId: result.lastInsertRowid === undefined ? null : Number(result.lastInsertRowid),
  });
  const runOne = (sql: string, params: readonly SqlValue[]) => toResult(db.prepare(sql).run(...params));

  return {
    async get<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async run(sql, ...params) {
      return runOne(sql, params);
    },
    async batch(statements) {
      return db.transaction(() => statements.map((s) => runOne(s.sql, s.params)))();
    },
    async close() {
      db.close();
    },
  };
}

/** Opens a local database and applies the migrations. */
export async function openSqliteDb(path: string, migrations: readonly Migration[]): Promise<SqlDb> {
  const db = createSqliteDb(path);
  await migrate(db, migrations);
  return db;
}
