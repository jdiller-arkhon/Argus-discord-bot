import { describe, expect, it } from 'vitest';
import { loadArgusConfig } from '../src/config.js';
import { BOT_PERMISSIONS, type Fetch, inviteUrl, runChecks } from '../src/setup/checks.js';
import { validEnv } from './fixtures.js';

const APP_ID = validEnv.DISCORD_APPLICATION_ID;
const GUILD = '323456789012345678';
const STATUS_CHANNEL = '423456789012345678';

const env = (extra: Record<string, string> = {}) =>
  loadArgusConfig({
    ...validEnv,
    ARGUS_CLIENT: 'http',
    ARGUS_API_BASE_URL: 'https://argus.example/api/bot/',
    ARGUS_API_TOKEN: 'api-token',
    ARGUS_WEBHOOK_SECRET: 'a-webhook-secret-of-length',
    DISCORD_GUILD_ID: GUILD,
    ARGUS_STATUS_CHANNEL_ID: STATUS_CHANNEL,
    ...extra,
  }).env;

/** A fake fetch answering by URL; records every request. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn: Fetch = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    if (!route) throw new Error(`connect ECONNREFUSED ${url}`);
    return route();
  };
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status });

const healthy = {
  'https://discord.com/api/v10/applications/@me': json({ id: APP_ID, name: 'Argus' }),
  [`https://discord.com/api/v10/guilds/${GUILD}`]: json({ name: 'Arkhon Pilot Network' }),
  [`https://discord.com/api/v10/channels/${STATUS_CHANNEL}`]: json({ name: 'argus-status' }),
  'https://argus.example/api/bot/v1/status': json({ state: 'operational' }),
  'https://bot.example/healthz': json({ ok: true }),
};

describe('runChecks', () => {
  it('passes a fully working setup, sending each service its own credential', async () => {
    const { fetchFn, calls } = fakeFetch(healthy);
    const results = await runChecks(env(), fetchFn, 'https://bot.example/');
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ['Discord bot token', 'pass'],
      ['Server', 'pass'],
      ['ARGUS_STATUS_CHANNEL_ID', 'pass'],
      ['Argus API', 'pass'],
      ['Event webhook', 'pass'],
      ['Public address', 'pass'],
    ]);
    expect(calls.find((c) => c.url.includes('discord.com'))?.headers.authorization).toBe(`Bot ${validEnv.DISCORD_TOKEN}`);
    expect(calls.find((c) => c.url.includes('argus.example'))?.headers.authorization).toBe('Bearer api-token');
  });

  it('explains a bad Discord token and skips the Discord checks that depend on it', async () => {
    const { fetchFn } = fakeFetch({ ...healthy, 'https://discord.com/api/v10/applications/@me': json({}, 401) });
    const results = await runChecks(env(), fetchFn);
    expect(results[0]).toMatchObject({ status: 'fail', detail: expect.stringContaining('rejected DISCORD_TOKEN') });
    expect(results.map((r) => r.name)).not.toContain('Server');
  });

  it('catches a token from a different application', async () => {
    const { fetchFn } = fakeFetch({ ...healthy, 'https://discord.com/api/v10/applications/@me': json({ id: '999999999999999999' }) });
    const [token] = await runChecks(env(), fetchFn);
    expect(token).toMatchObject({ status: 'fail', detail: expect.stringContaining('999999999999999999') });
  });

  it('gives the invite link when the bot is not in the server, and flags hidden channels', async () => {
    const { fetchFn } = fakeFetch({
      ...healthy,
      [`https://discord.com/api/v10/guilds/${GUILD}`]: json({}, 403),
      [`https://discord.com/api/v10/channels/${STATUS_CHANNEL}`]: json({}, 404),
    });
    const results = await runChecks(env(), fetchFn);
    expect(results[1]).toMatchObject({ status: 'fail', detail: expect.stringContaining('discord.com/oauth2/authorize') });
    expect(results[2]).toMatchObject({ status: 'fail', detail: expect.stringContaining("can't see channel") });
  });

  it('explains a rejected or misaddressed Argus API', async () => {
    const rejected = fakeFetch({ ...healthy, 'https://argus.example/api/bot/v1/status': json({}, 401) });
    const api = (await runChecks(env(), rejected.fetchFn)).find((r) => r.name === 'Argus API');
    expect(api).toMatchObject({ status: 'fail', detail: expect.stringContaining('DISCORD_BOT_API_TOKEN') });

    const missing = fakeFetch({ ...healthy, 'https://argus.example/api/bot/v1/status': json({}, 404) });
    const notFound = (await runChecks(env(), missing.fetchFn)).find((r) => r.name === 'Argus API');
    expect(notFound).toMatchObject({ status: 'fail', detail: expect.stringContaining('/api/bot') });
  });

  it('warns about mock mode, a missing webhook secret and a missing server ID', async () => {
    const { fetchFn } = fakeFetch(healthy);
    const results = await runChecks(
      env({ ARGUS_CLIENT: 'mock', ARGUS_WEBHOOK_SECRET: '', DISCORD_GUILD_ID: '' }),
      fetchFn,
    );
    const status = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(status).toMatchObject({ Server: 'warn', 'Argus API': 'warn', 'Event webhook': 'warn' });
  });

  it('reports an unreachable or not-yet-connected public address', async () => {
    const down = await runChecks(env(), fakeFetch(healthy).fetchFn, 'https://nowhere.example');
    expect(down.at(-1)).toMatchObject({ name: 'Public address', status: 'fail' });

    const starting = fakeFetch({ ...healthy, 'https://bot.example/healthz': json({ ok: false }, 503) });
    const results = await runChecks(env(), starting.fetchFn, 'https://bot.example');
    expect(results.at(-1)).toMatchObject({ status: 'warn' });
  });
});

describe('inviteUrl', () => {
  it('asks for the bot and slash command scopes with the bot permissions', () => {
    const url = new URL(inviteUrl(APP_ID, GUILD));
    expect(url.searchParams.get('client_id')).toBe(APP_ID);
    expect(url.searchParams.get('scope')).toBe('bot applications.commands');
    expect(url.searchParams.get('permissions')).toBe(BOT_PERMISSIONS.toString());
    expect(url.searchParams.get('guild_id')).toBe(GUILD);
    expect(new URL(inviteUrl(APP_ID)).searchParams.has('guild_id')).toBe(false);
  });

  it('never asks for Administrator', () => {
    expect(BOT_PERMISSIONS & 8n).toBe(0n);
  });
});
