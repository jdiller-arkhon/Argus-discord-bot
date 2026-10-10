import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TtlCache } from '../src/cache.js';
import { claimJobRun, jobRunsMigrationSql, openDatabase, releaseJobRun } from '../src/db.js';
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
  it('claims a run once and can release it', () => {
    const db = openDatabase(':memory:', [{ version: 1, name: 'jobs', sql: jobRunsMigrationSql }]);
    expect(claimJobRun(db, 'job', '2026-10-09')).toBe(true);
    expect(claimJobRun(db, 'job', '2026-10-09')).toBe(false);
    releaseJobRun(db, 'job', '2026-10-09');
    expect(claimJobRun(db, 'job', '2026-10-09')).toBe(true);
  });

  it('rejects non-contiguous migrations', () => {
    expect(() => openDatabase(':memory:', [{ version: 2, name: 'x', sql: '' }])).toThrow(/contiguous/);
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
