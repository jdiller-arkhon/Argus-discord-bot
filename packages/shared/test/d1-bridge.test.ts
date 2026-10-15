import { describe, expect, it } from 'vitest';
import { handleD1BridgeRequest, parseD1BridgeRequest, rowsFromRaw } from '../src/d1-bridge.js';
import { bridged, fakeD1 } from './d1-fake.js';
import { migrate, stmt } from '../src/sql.js';

describe('D1 bridge', () => {
  it('runs reads, writes and atomic batches through the Worker', async () => {
    const { db } = bridged();
    await migrate(db, [{ version: 1, name: 't', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, n REAL);' }]);

    const inserted = await db.run('INSERT INTO t (name, n) VALUES (?, ?)', 'a', 1.5);
    expect(inserted).toEqual({ changes: 1, lastRowId: 1 });
    expect(await db.get('SELECT name, n FROM t WHERE id = ?', 1)).toEqual({ name: 'a', n: 1.5 });
    expect(await db.get('SELECT name FROM t WHERE id = ?', 99)).toBeUndefined();
    expect(await db.all('SELECT name FROM t ORDER BY id')).toEqual([{ name: 'a' }]);

    // The second insert breaks the UNIQUE constraint, so the first must not apply either.
    await expect(db.batch([stmt('INSERT INTO t (name) VALUES (?)', 'b'), stmt('INSERT INTO t (name) VALUES (?)', 'a')])).rejects.toThrow(
      /UNIQUE/,
    );
    expect(await db.all('SELECT name FROM t ORDER BY id')).toEqual([{ name: 'a' }]);

    const results = await db.batch([stmt('INSERT INTO t (name) VALUES (?)', 'b'), stmt('DELETE FROM t WHERE name = ?', 'a')]);
    expect(results.map((r) => r.changes)).toEqual([1, 1]);
    expect(await db.all('SELECT name FROM t')).toEqual([{ name: 'b' }]);
  });

  it('passes D1 errors back with their message', async () => {
    const { db } = bridged();
    await expect(db.get('SELECT * FROM missing')).rejects.toThrow(/no such table/);
  });

  it('rejects malformed requests', async () => {
    const d1 = fakeD1();
    const post = (body: unknown) => handleD1BridgeRequest(new Request('http://d1.internal/', { method: 'POST', body: JSON.stringify(body) }), d1);
    expect((await post({ op: 'drop' })).status).toBe(400);
    expect((await post({ op: 'run', sql: 1, params: [] })).status).toBe(400);
    expect((await handleD1BridgeRequest(new Request('http://d1.internal/'), d1)).status).toBe(405);
    expect(parseD1BridgeRequest({ op: 'batch', statements: [{ sql: 'x' }] })).toBeUndefined();
  });

  it('maps raw rows with column names to objects', () => {
    expect(rowsFromRaw([['a', 'b'], [1, 'x'], [2, null]])).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: null },
    ]);
    expect(rowsFromRaw([])).toEqual([]);
  });
});
