import type { AddressInfo } from 'node:net';
import { signBody, silentLogger } from '@arkhon/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { openArgusDatabase } from '../src/db.js';
import type { DispatchResult } from '../src/events/dispatch.js';
import { sampleEvent } from '../src/events/samples.js';
import type { ArgusEvent } from '../src/events/types.js';
import { ArgusStore } from '../src/store.js';
import { createWebhookServer, SIGNATURE_HEADER, WEBHOOK_PATH } from '../src/webhook/server.js';

const SECRET = 'test-webhook-secret-123';
const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function start(options: { ready?: boolean; dispatch?: (event: ArgusEvent) => Promise<DispatchResult> } = {}) {
  const store = new ArgusStore(openArgusDatabase(':memory:'));
  const dispatched: ArgusEvent[] = [];
  const server = createWebhookServer({
    secret: SECRET,
    logger: silentLogger,
    isReady: () => options.ready ?? true,
    claimEvent: (id, type) => store.claimEvent(id, type),
    releaseEvent: (id) => store.releaseEvent(id),
    dispatch:
      options.dispatch ??
      (async (event) => {
        dispatched.push(event);
        return { route: 'dm', delivered: true };
      }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const post = async (body: string, signature: string | null = signBody(body, SECRET), path = WEBHOOK_PATH) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (signature !== null) headers[SIGNATURE_HEADER] = signature;
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { base, post, dispatched, store };
}

describe('Argus webhook server', () => {
  it('accepts a correctly signed event and dispatches it', async () => {
    const { post, dispatched } = await start();
    const event = sampleEvent('payout.paid', { userId: 'argus-1' });
    const result = await post(JSON.stringify(event));
    expect(result).toEqual({ status: 200, body: { ok: true, route: 'dm', delivered: true } });
    expect(dispatched).toEqual([event]);
  });

  it('rejects missing and wrong signatures before parsing anything', async () => {
    const { post, dispatched } = await start();
    const body = JSON.stringify(sampleEvent('payout.paid'));
    expect((await post(body, null)).status).toBe(401);
    expect((await post(body, signBody(body, 'another-secret-entirely'))).status).toBe(401);
    // Signature over a different body (e.g. re-serialized JSON) fails too.
    expect((await post(`${body}\n`, signBody(body, SECRET))).status).toBe(401);
    expect((await post('not json', null)).status).toBe(401);
    expect(dispatched).toEqual([]);
  });

  it('processes each event id once, so Argus retries are not delivered twice', async () => {
    const { post, dispatched } = await start();
    const body = JSON.stringify(sampleEvent('job.step', { userId: 'argus-1' }));
    expect((await post(body)).status).toBe(200);
    expect(await post(body)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(dispatched).toHaveLength(1);
  });

  it('releases the id when delivery fails so the retry is processed', async () => {
    let fail = true;
    const { post } = await start({
      dispatch: async () => {
        if (fail) throw new Error('channel missing');
        return { route: 'channel', delivered: true };
      },
    });
    const body = JSON.stringify(sampleEvent('mission.posted'));
    expect((await post(body)).status).toBe(500);
    fail = false;
    expect(await post(body)).toEqual({ status: 200, body: { ok: true, route: 'channel', delivered: true } });
  });

  it('acknowledges unknown event types with 202 for forward compatibility', async () => {
    const { post, dispatched } = await start();
    const body = JSON.stringify({ id: 'evt_x', type: 'quote.created', occurredAt: '2026-10-10T12:00:00Z', userId: null, data: {} });
    expect(await post(body)).toEqual({ status: 202, body: { ok: true, ignored: 'unknown event type quote.created' } });
    expect(dispatched).toEqual([]);
  });

  it('returns 400 with issues for signed but invalid payloads', async () => {
    const { post } = await start();
    const bad = { ...sampleEvent('payout.paid'), data: { amountCents: -5 } };
    const result = await post(JSON.stringify(bad));
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid payload');
    expect(await post('{not json')).toMatchObject({ status: 400, body: { error: 'body must be JSON' } });
  });

  it('returns 503 until Discord is ready, without consuming the event id', async () => {
    const { post, store } = await start({ ready: false });
    const event = sampleEvent('payout.paid');
    expect((await post(JSON.stringify(event))).status).toBe(503);
    expect(store.claimEvent(event.id, event.type)).toBe(true);
  });

  it('serves health and rejects other routes and methods', async () => {
    const { base, post } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}${WEBHOOK_PATH}`)).status).toBe(405);
    expect((await post('{}', null, '/webhooks/other')).status).toBe(404);
  });
});
