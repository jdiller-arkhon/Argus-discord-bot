import { describe, expect, it } from 'vitest';
import {
  ArgusAuthError,
  ArgusInvalidLinkCodeError,
  ArgusNotFoundError,
  ArgusRejectedError,
  ArgusResponseError,
  ArgusUnavailableError,
  ArgusUserNotFoundError,
} from '../src/argus/client.js';
import { HttpArgusClient } from '../src/argus/http-client.js';
import { createArgusClient, withStatusFrom } from '../src/argus/index.js';
import { MockArgusClient } from '../src/argus/mock-client.js';
import { openArgusDatabase } from '../src/db.js';
import { NOW, testConfig, USER } from './fixtures.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(responses: (() => Response | Promise<Response>)[], options: { statusUrl?: string; timeoutMs?: number } = {}) {
  const fake = fakeFetch(responses);
  const sleeps: number[] = [];
  const argus = new HttpArgusClient({
    baseUrl: 'https://argus.example.com/api/',
    token: 'secret-token',
    fetchFn: fake.fn,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-10-10T18:00:00Z'),
    ...options,
  });
  return { argus, calls: fake.calls, sleeps };
}

const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

const jobSummary = {
  id: 1042,
  title: 'Roof inspection',
  serviceType: 'Roof Inspection',
  status: 'in_progress',
  paymentStatus: 'paid',
  scheduledFor: '2026-10-10',
  timeWindow: 'morning',
  amountCents: 37_500,
  locality: 'Boulder, CO',
  viewerRole: 'client',
  counterpartName: 'Ava R.',
  latestStep: 'on_site',
};

describe('HttpArgusClient', () => {
  it('redeems link codes with a bearer token and an idempotency key', async () => {
    const { argus, calls } = client([json(200, { argusUserId: 'u_1', displayName: 'Ava', role: 'pilot', email: 'x@y.z' })]);
    expect(await argus.redeemLinkCode('ABC-123', USER)).toEqual({ argusUserId: 'u_1', displayName: 'Ava', role: 'pilot' });
    const [call] = calls;
    expect(call!.url).toBe('https://argus.example.com/api/v1/discord/link-codes/redeem');
    expect(call!.init.method).toBe('POST');
    expect(header(call!, 'authorization')).toBe('Bearer secret-token');
    expect(header(call!, 'idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(String(call!.init.body))).toEqual({ code: 'ABC-123', discordUserId: USER });
  });

  it('strips unknown keys, such as exact addresses, from responses', async () => {
    const { argus, calls } = client([json(200, { jobs: [{ ...jobSummary, address: '1420 Pine St' }] })]);
    const [job] = await argus.listJobs('u/1', 'active');
    expect(job).toEqual(jobSummary);
    expect(job).not.toHaveProperty('address');
    expect(calls[0]!.url).toBe('https://argus.example.com/api/v1/users/u%2F1/jobs?scope=active');
    expect(header(calls[0]!, 'idempotency-key')).toBeUndefined();
  });

  it('retries 5xx with exponential backoff, three attempts in total', async () => {
    const { argus, calls, sleeps } = client([json(502, {}), json(503, {}), json(200, { jobs: [] })]);
    expect(await argus.listJobs('u_1', 'recent')).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1000]);
  });

  it('gives up after three 5xx responses', async () => {
    const { argus, calls } = client([json(500, {}), json(500, {}), json(500, {})]);
    await expect(argus.getEarnings('u_1')).rejects.toBeInstanceOf(ArgusUnavailableError);
    expect(calls).toHaveLength(3);
  });

  it('times out each attempt and retries', async () => {
    let attempts = 0;
    const argus = new HttpArgusClient({
      baseUrl: 'https://argus.example.com',
      token: 't',
      timeoutMs: 20,
      sleep: async () => {},
      // Never responds; only the per-attempt timeout's abort signal ends it.
      fetchFn: ((_url: string, init: RequestInit) => {
        attempts++;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }) as unknown as typeof fetch,
    });
    await expect(argus.getCredentials('u_1')).rejects.toBeInstanceOf(ArgusUnavailableError);
    expect(attempts).toBe(3);
  });

  it('does not retry 4xx and maps them to typed errors', async () => {
    const fail = async (status: number, body: unknown, call: (c: HttpArgusClient) => Promise<unknown>) => {
      const { argus, calls } = client([json(status, body)]);
      const error = await call(argus).catch((e: unknown) => e);
      expect(calls).toHaveLength(1);
      return error;
    };
    expect(await fail(404, {}, (c) => c.redeemLinkCode('ABCDEF', USER))).toBeInstanceOf(ArgusInvalidLinkCodeError);
    expect(await fail(410, {}, (c) => c.redeemLinkCode('ABCDEF', USER))).toBeInstanceOf(ArgusInvalidLinkCodeError);
    expect(await fail(404, {}, (c) => c.getEarnings('u_1'))).toBeInstanceOf(ArgusUserNotFoundError);
    expect(await fail(404, {}, (c) => c.getJob('u_1', 5))).toBeInstanceOf(ArgusNotFoundError);
    expect(await fail(404, { code: 'user_not_found' }, (c) => c.getJob('u_1', 5))).toBeInstanceOf(ArgusUserNotFoundError);
    expect(await fail(401, {}, (c) => c.getEarnings('u_1'))).toBeInstanceOf(ArgusAuthError);
    expect(await fail(403, {}, (c) => c.getEarnings('u_1'))).toBeInstanceOf(ArgusAuthError);
    const forbidden = await fail(403, { code: 'not_allowed', message: 'Pilots only.' }, (c) => c.getEarnings('u_1'));
    expect(forbidden).toBeInstanceOf(ArgusRejectedError);
    expect((forbidden as ArgusRejectedError).detail).toBe('Pilots only.');
    const taken = await fail(409, { message: 'Another pilot accepted this mission first.' }, (c) => c.acceptMission('u_1', 9));
    expect(taken).toBeInstanceOf(ArgusRejectedError);
    expect((taken as ArgusRejectedError).detail).toBe('Another pilot accepted this mission first.');
  });

  it('rejects responses that do not match the schema', async () => {
    const { argus } = client([json(200, { jobs: [{ ...jobSummary, status: 'flying' }] })]);
    await expect(argus.listJobs('u_1', 'active')).rejects.toBeInstanceOf(ArgusResponseError);
    const { argus: textClient } = client([() => new Response('<html>oops</html>', { status: 200 })]);
    await expect(textClient.getEarnings('u_1')).rejects.toBeInstanceOf(ArgusResponseError);
  });

  it('reads /v1/status by default', async () => {
    const body = { state: 'degraded', summary: 'Slow uploads', components: [], updatedAt: '2026-10-10T17:00:00Z' };
    const { argus, calls } = client([json(200, body)]);
    expect(await argus.getServiceStatus()).toEqual(body);
    expect(calls[0]!.url).toBe('https://argus.example.com/api/v1/status');
  });

  it("maps the platform's existing /api/health probe, without sending the API token", async () => {
    const statusUrl = 'https://arkhonindustries.com/api/health';
    const { argus, calls } = client([json(200, { ok: true, db: 'ok' })], { statusUrl });
    expect(await argus.getServiceStatus()).toMatchObject({
      state: 'operational',
      components: [{ name: 'Database', state: 'operational' }],
    });
    expect(calls[0]!.url).toBe(statusUrl);
    expect(header(calls[0]!, 'authorization')).toBeUndefined();

    const down = client([json(503, { ok: false, db: 'error' }), json(503, { ok: false }), json(503, { ok: false })], { statusUrl });
    expect(await down.argus.getServiceStatus()).toMatchObject({ state: 'outage', updatedAt: '2026-10-10T18:00:00.000Z' });
  });
});

describe('MockArgusClient', () => {
  const setup = () => {
    const db = openArgusDatabase(':memory:');
    return new MockArgusClient(db, { timezone: 'America/Denver', now: () => NOW });
  };

  it('links by code prefix, once per code, keeping data across relinks', async () => {
    const mock = setup();
    expect(await mock.redeemLinkCode('client-1', USER)).toEqual({ argusUserId: `mock-client-${USER}`, displayName: 'Client 5678', role: 'client' });
    await expect(mock.redeemLinkCode('CLIENT-1', USER)).rejects.toBeInstanceOf(ArgusInvalidLinkCodeError);
    const before = await mock.listJobs(`mock-client-${USER}`, 'active');
    await mock.redeemLinkCode('CLIENT-2', USER);
    expect(await mock.listJobs(`mock-client-${USER}`, 'active')).toEqual(before);
    expect((await mock.redeemLinkCode('ANYTHING', USER)).role).toBe('pilot');
    expect((await mock.redeemLinkCode('ADMIN-1', USER)).role).toBe('admin');
  });

  it('seeds clients with jobs in every interesting state', async () => {
    const mock = setup();
    const { argusUserId } = await mock.redeemLinkCode('CLIENT-1', USER);
    const active = await mock.listJobs(argusUserId, 'active');
    expect(active.map((j) => j.status)).toEqual(['review', 'in_progress', 'pending']);
    expect(active.find((j) => j.status === 'in_progress')?.latestStep).toBe('in_flight');
    expect((await mock.listJobs(argusUserId, 'recent')).map((j) => j.status)).toEqual(['completed']);
    await expect(mock.getEarnings(argusUserId)).rejects.toBeInstanceOf(ArgusRejectedError);
  });

  it('lets exactly one pilot win a mission', async () => {
    const mock = setup();
    const a = (await mock.redeemLinkCode('PILOT-A', USER)).argusUserId;
    const b = (await mock.redeemLinkCode('PILOT-B', '999999999999999999')).argusUserId;
    const board = await mock.listOpenMissions(a);
    expect(board).toMatchObject({ canAccept: true, tier: 'established' });
    expect(board.missions).toHaveLength(4);
    const missionId = board.missions[0]!.id;
    const accepted = await mock.acceptMission(a, missionId);
    expect(accepted).toMatchObject({ missionId, title: board.missions[0]!.title });
    await expect(mock.acceptMission(b, missionId)).rejects.toBeInstanceOf(ArgusRejectedError);
    expect((await mock.getJob(a, accepted.jobId)).viewerRole).toBe('pilot');
    await expect(mock.getJob(b, accepted.jobId)).rejects.toBeInstanceOf(ArgusNotFoundError);
    await expect(mock.acceptMission(a, 9999)).rejects.toBeInstanceOf(ArgusNotFoundError);
  });

  it('refuses missions to unverified pilots and refills an empty board', async () => {
    const mock = setup();
    const pilot = (await mock.redeemLinkCode('PILOT-A', USER)).argusUserId;
    const board = await mock.listOpenMissions(pilot);
    for (const m of board.missions) await mock.acceptMission(pilot, m.id);
    expect((await mock.listOpenMissions(pilot)).missions).toHaveLength(4);
    mock.setPilotVerification(pilot, 'verified', true);
    expect((await mock.listOpenMissions(pilot)).canAccept).toBe(false);
    await expect(mock.acceptMission(pilot, (await mock.listOpenMissions(pilot)).missions[0]!.id)).rejects.toBeInstanceOf(
      ArgusRejectedError,
    );
  });

  it('reports pilot credentials and a settable service status', async () => {
    const mock = setup();
    const pilot = (await mock.redeemLinkCode('PILOT-A', USER)).argusUserId;
    const creds = await mock.getCredentials(pilot);
    expect(creds.credentials.map((c) => c.kind).sort()).toEqual(['drone_reg', 'faa_part107', 'id', 'insurance']);
    expect(creds.credentials.find((c) => c.kind === 'insurance')?.expiresAt).toBe('2026-11-04');
    expect((await mock.getServiceStatus()).state).toBe('operational');
    mock.setServiceStatus('outage', 'Database unreachable');
    expect(await mock.getServiceStatus()).toMatchObject({ state: 'outage', summary: 'Database unreachable' });
    await expect(mock.getEarnings('mock-pilot-nobody')).rejects.toBeInstanceOf(ArgusUserNotFoundError);
  });
});

describe('createArgusClient', () => {
  it('uses the mock, or the mock plus a real status source when ARGUS_STATUS_URL is set', async () => {
    const db = openArgusDatabase(':memory:');
    expect(createArgusClient(testConfig(), db)).toBeInstanceOf(MockArgusClient);
    const combined = createArgusClient(testConfig({ ARGUS_STATUS_URL: 'https://arkhonindustries.com/api/health' }), db);
    expect(combined).not.toBeInstanceOf(MockArgusClient);
    expect((await combined.redeemLinkCode('PILOT-1', USER)).role).toBe('pilot');
    expect(createArgusClient(testConfig({ ARGUS_CLIENT: 'http', ARGUS_API_BASE_URL: 'https://a.test', ARGUS_API_TOKEN: 't' }), db)).toBeInstanceOf(
      HttpArgusClient,
    );
  });

  it('routes only status calls to the status source', async () => {
    const mock = new MockArgusClient(openArgusDatabase(':memory:'), { timezone: 'America/Denver', now: () => NOW });
    const outage = { state: 'outage' as const, summary: null, components: [], updatedAt: '2026-10-10T18:00:00Z' };
    const client = withStatusFrom(mock, { getServiceStatus: async () => outage });
    expect(await client.getServiceStatus()).toBe(outage);
    const { argusUserId } = await client.redeemLinkCode('CLIENT-1', USER);
    expect(await client.listJobs(argusUserId, 'active')).toHaveLength(3);
  });
});
