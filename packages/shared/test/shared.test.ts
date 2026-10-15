import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TtlCache } from '../src/cache.js';
import { claimJobRun, jobRunsMigrationSql, releaseJobRun, splitStatements } from '../src/sql.js';
import { createSqliteDb, openSqliteDb } from '../src/sqlite.js';
import { ConfigError, csvList, loadEnv } from '../src/env.js';
import { HttpError, request } from '../src/http.js';
import { dueRunKey } from '../src/scheduler.js';

describe('dueRunKey', () => {
  const at = (iso: string) => DateTime.fromISO(iso, { zone: 'America/Denver' });

  it('is due daily from the configured time onward', () => {
    expect(dueRunKey({ kind: 'daily', time: '06:30' }, at('2026-10-09T06:29'))).toBeNull();
    expect(dueRunKey({ kind: 'daily', time: '06:30' }, at('2026-10-09T06:30'))).toBe('2026-10-09');
    expect(dueRunKey({ kind: 'daily', time: '06:30' }, at('2026-10-09T23:59'))).toBe('2026-10-09');
  });

  it('is due monthly only on the configured day', () => {
    const schedule = { kind: 'monthly', day: 1, time: '09:00' } as const;
    expect(dueRunKey(schedule, at('2026-11-01T08:59'))).toBeNull();
    expect(dueRunKey(schedule, at('2026-11-01T09:00'))).toBe('2026-11');
    expect(dueRunKey(schedule, at('2026-11-02T09:00'))).toBeNull();
  });
});

describe('job runs', () => {
  it('claims a run once and can release it', async () => {
    const db = await openSqliteDb(':memory:', [{ version: 1, name: 'jobs', sql: jobRunsMigrationSql }]);
    expect(await claimJobRun(db, 'job', '2026-10-09')).toBe(true);
    expect(await claimJobRun(db, 'job', '2026-10-09')).toBe(false);
    await releaseJobRun(db, 'job', '2026-10-09');
    expect(await claimJobRun(db, 'job', '2026-10-09')).toBe(true);
  });

  it('rejects non-contiguous migrations', async () => {
    await expect(openSqliteDb(':memory:', [{ version: 2, name: 'x', sql: '' }])).rejects.toThrow(/contiguous/);
  });
});

describe('migrations', () => {
  it('applies each migration once and records it', async () => {
    const db = createSqliteDb(':memory:');
    const migrations = [
      { version: 1, name: 'a', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);\n-- a comment line\nCREATE INDEX a_id ON a (id);' },
      { version: 2, name: 'b', sql: 'CREATE TABLE b (id INTEGER PRIMARY KEY);' },
    ];
    const { migrate } = await import('../src/sql.js');
    expect(await migrate(db, migrations.slice(0, 1))).toEqual([1]);
    expect(await migrate(db, migrations)).toEqual([2]);
    expect(await migrate(db, migrations)).toEqual([]);
    expect(await db.all('SELECT version, name FROM schema_migrations ORDER BY version')).toEqual([
      { version: 1, name: 'a' },
      { version: 2, name: 'b' },
    ]);
  });

  it('applies nothing from a migration whose statement fails', async () => {
    const db = createSqliteDb(':memory:');
    const { migrate } = await import('../src/sql.js');
    await expect(
      migrate(db, [{ version: 1, name: 'bad', sql: 'CREATE TABLE ok (id INTEGER);\nCREATE TABLE ok (id INTEGER);' }]),
    ).rejects.toThrow();
    expect(await db.get("SELECT name FROM sqlite_master WHERE name = 'ok'")).toBeUndefined();
  });

  it('splits statements on line-ending semicolons and drops comment lines', () => {
    expect(splitStatements('-- note\nCREATE TABLE x (\n  id INTEGER\n);\n\nCREATE INDEX i ON x (id);\n')).toEqual([
      'CREATE TABLE x (\n  id INTEGER\n)',
      'CREATE INDEX i ON x (id)',
    ]);
  });
});

describe('TtlCache', () => {
  it('expires entries and coalesces concurrent loads', async () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, () => now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await Promise.all([cache.getOrLoad('k', load), cache.getOrLoad('k', load)])).toEqual([1, 1]);
    now = 999;
    expect(await cache.getOrLoad('k', load)).toBe(1);
    now = 1000;
    expect(await cache.getOrLoad('k', load)).toBe(2);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.getOrLoad('k', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await cache.getOrLoad('k', async () => 7)).toBe(7);
  });
});

describe('request', () => {
  it('fails fast on 4xx', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response('nope', { status: 400 });
    }) as unknown as typeof fetch;
    await expect(request('https://x', { attempts: 3, fetchFn })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });
});

describe('loadEnv', () => {
  it('treats blank values as unset and reports every problem', () => {
    const schema = z.object({ A: z.string(), B: z.string().default('b'), C: csvList.default('') });
    expect(loadEnv(schema, { A: 'a', B: '  ', C: 'x, y' })).toEqual({ A: 'a', B: 'b', C: ['x', 'y'] });
    expect(() => loadEnv(schema, {})).toThrow(ConfigError);
  });
});
