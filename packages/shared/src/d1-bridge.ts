/**
 * Cloudflare D1 for a bot running in a container.
 *
 * On Cloudflare the bot runs in a container, which cannot hold a D1 binding. Its Worker can, so it
 * answers plain HTTP requests the container sends to http://d1.internal (intercepted by the
 * Worker, never public) and runs them against its `DB` binding. The wire format is the Ops bot's
 * (jdiller-arkhon/Arkhon-ops-bot packages/shared/src/d1-bridge.ts), so one Worker could serve both.
 *
 * - {@link createD1BridgeDb}: the container side, a {@link SqlDb}.
 * - {@link handleD1BridgeRequest}: the Worker side (deploy/cloudflare).
 *
 * Runtime-neutral: works in Node and in Workers.
 */
import type { RunResult, SqlDb, SqlValue } from './sql.js';

export const D1_BRIDGE_HOST = 'd1.internal';
export const D1_BRIDGE_URL = `http://${D1_BRIDGE_HOST}`;

export interface D1BridgeStatement {
  sql: string;
  params: unknown[];
}

export type D1BridgeRequest =
  | { op: 'run' | 'raw'; sql: string; params: unknown[] }
  | { op: 'exec'; sql: string }
  | { op: 'batch'; statements: D1BridgeStatement[] };

export type D1BridgeResponse = { ok: true; result: unknown } | { ok: false; error: string };

/** Validates an incoming request body; undefined for anything malformed. */
export function parseD1BridgeRequest(body: unknown): D1BridgeRequest | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const isStatement = (s: unknown): s is D1BridgeStatement =>
    !!s && typeof s === 'object' && typeof (s as D1BridgeStatement).sql === 'string' && Array.isArray((s as D1BridgeStatement).params);
  switch (b.op) {
    case 'run':
    case 'raw':
      return typeof b.sql === 'string' && Array.isArray(b.params) ? { op: b.op, sql: b.sql, params: b.params } : undefined;
    case 'exec':
      return typeof b.sql === 'string' ? { op: 'exec', sql: b.sql } : undefined;
    case 'batch':
      return Array.isArray(b.statements) && b.statements.every(isStatement)
        ? { op: 'batch', statements: b.statements }
        : undefined;
    default:
      return undefined;
  }
}

/** The subset of the D1 binding the Worker side uses, so tests can pass a fake. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      raw(options: { columnNames: true }): Promise<unknown[][]>;
    };
  };
  exec(sql: string): Promise<unknown>;
  batch(statements: unknown[]): Promise<unknown[]>;
}

/** Worker side: runs one bridge request against the D1 binding. */
export async function handleD1BridgeRequest(request: Request, db: D1Like): Promise<Response> {
  const json = (body: D1BridgeResponse, status = 200) => Response.json(body, { status });
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }
  const op = parseD1BridgeRequest(body);
  if (!op) return json({ ok: false, error: 'invalid D1 bridge request' }, 400);
  try {
    let result: unknown;
    switch (op.op) {
      case 'run':
        result = await db.prepare(op.sql).bind(...op.params).run();
        break;
      case 'raw':
        result = await db.prepare(op.sql).bind(...op.params).raw({ columnNames: true });
        break;
      case 'exec':
        result = await db.exec(op.sql);
        break;
      case 'batch':
        result = await db.batch(op.statements.map((s) => db.prepare(s.sql).bind(...s.params)));
        break;
    }
    return json({ ok: true, result });
  } catch (error) {
    // 200 with ok:false: the request reached D1 and D1 refused it; the client throws the message.
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface D1RunMeta {
  meta?: { changes?: number; last_row_id?: number | null };
}

const toRunResult = (result: unknown): RunResult => {
  const meta = (result as D1RunMeta | null)?.meta ?? {};
  return { changes: meta.changes ?? 0, lastRowId: meta.last_row_id ?? null };
};

/** Rows from D1's `raw({ columnNames: true })`: the first row holds the column names. */
export function rowsFromRaw<T>(raw: unknown[][]): T[] {
  const [columns, ...rows] = raw;
  if (!columns) return [];
  return rows.map((row) => Object.fromEntries(columns.map((name, i) => [String(name), row[i]])) as T);
}

/** Container side: a {@link SqlDb} that sends every query to the Worker at `baseUrl`. */
export function createD1BridgeDb(baseUrl: string = D1_BRIDGE_URL, fetchFn: FetchLike = fetch): SqlDb {
  const url = baseUrl.replace(/\/+$/, '') + '/';

  async function call(request: D1BridgeRequest): Promise<unknown> {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const text = await res.text();
    let parsed: { ok?: boolean; result?: unknown; error?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`D1 bridge returned ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!parsed.ok) throw new Error(parsed.error ?? `D1 bridge error (${res.status})`);
    return parsed.result;
  }

  const rows = async <T>(sql: string, params: SqlValue[]) =>
    rowsFromRaw<T>((await call({ op: 'raw', sql, params })) as unknown[][]);

  return {
    async get<T>(sql: string, ...params: SqlValue[]) {
      return (await rows<T>(sql, params))[0];
    },
    all: <T>(sql: string, ...params: SqlValue[]) => rows<T>(sql, params),
    async run(sql, ...params) {
      return toRunResult(await call({ op: 'run', sql, params }));
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      const results = (await call({
        op: 'batch',
        statements: statements.map((s) => ({ sql: s.sql, params: [...s.params] })),
      })) as unknown[];
      return results.map(toRunResult);
    },
    async close() {},
  };
}
