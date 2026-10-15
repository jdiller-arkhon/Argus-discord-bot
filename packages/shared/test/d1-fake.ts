import Database from 'better-sqlite3';
import { createD1BridgeDb, type D1Like, handleD1BridgeRequest } from '../src/d1-bridge.js';

/**
 * A stand-in for the Worker's D1 binding, over SQLite, with D1's result shapes:
 * run() -> { meta: { changes, last_row_id } }, raw({ columnNames }) -> [columns, ...rows],
 * batch() -> one result per statement, applied in a single transaction.
 */
export function fakeD1(): D1Like {
  const sqlite = new Database(':memory:');
  type Bound = { sql: string; values: unknown[] };
  const runBound = ({ sql, values }: Bound) => {
    const result = sqlite.prepare(sql).run(...(values as never[]));
    return { success: true, meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
  };
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const bound: Bound & { run(): Promise<unknown>; raw(o: { columnNames: true }): Promise<unknown[][]> } = {
            sql,
            values,
            run: async () => runBound(bound),
            raw: async () => {
              const prepared = sqlite.prepare(sql);
              const columns = prepared.columns().map((c) => c.name);
              return [columns, ...(prepared.raw().all(...(values as never[])) as unknown[][])];
            },
          };
          return bound;
        },
      };
    },
    exec: async (sql) => sqlite.exec(sql),
    batch: async (statements) => sqlite.transaction(() => (statements as Bound[]).map(runBound))(),
  };
}

/** The container's client wired straight to the Worker's handler, as the Worker routes it. */
export function bridged() {
  const d1 = fakeD1();
  const requests: unknown[] = [];
  const db = createD1BridgeDb('http://d1.internal', async (url, init) => {
    requests.push(JSON.parse(String(init.body)));
    return handleD1BridgeRequest(new Request(url, init), d1);
  });
  return { db, requests };
}

