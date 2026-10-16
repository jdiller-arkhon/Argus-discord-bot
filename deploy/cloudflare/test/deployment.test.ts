import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_PATH } from '../../../bots/argus/src/webhook/server.js';
import { BOT_PATHS, containerEnv, DEFAULTS, ENV_KEYS, envFingerprint, isBotPath, missingRequired, REQUIRED, workerSecrets } from '../src/deployment.js';

const root = new URL('../../../', import.meta.url);

function envExampleKeys(): string[] {
  const text = readFileSync(new URL('.env.example', root), 'utf8');
  return [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

/** wrangler.jsonc without comments or trailing commas. */
function wranglerConfig() {
  const text = readFileSync(new URL('deploy/cloudflare/wrangler.jsonc', root), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as {
    containers: { class_name: string; max_instances: number; image: string }[];
    durable_objects: { bindings: { name: string; class_name: string }[] };
    d1_databases: { binding: string; database_id: string }[];
    triggers: { crons: string[] };
  };
}

describe('Argus on Cloudflare', () => {
  it('passes every bot setting from .env.example except the ones the deployment fixes', () => {
    const fixed = new Set(['ARGUS_DB_PATH', 'D1_BRIDGE_URL', 'ARGUS_WEBHOOK_HOST', 'ARGUS_WEBHOOK_PORT', 'CERTA_DB_PATH']);
    expect([...ENV_KEYS].sort()).toEqual(envExampleKeys().filter((key) => !fixed.has(key)).sort());
  });

  it('forwards exactly the routes the bot serves', () => {
    expect([...BOT_PATHS].sort()).toEqual(['/healthz', WEBHOOK_PATH].sort());
    expect(isBotPath(WEBHOOK_PATH)).toBe(true);
    expect(isBotPath('/')).toBe(false);
    expect(isBotPath('/webhooks/argus/extra')).toBe(false);
  });

  it('copies set values over the production defaults and fixes the database and listener', () => {
    const env = containerEnv({
      DISCORD_TOKEN: 'token',
      ARGUS_STATUS_URL: 'https://status.example/health',
      ARGUS_TICKET_MODE: '',
      ARGUS_BOT: { not: 'a string' },
      UNRELATED: 'ignored',
      ARGUS_DB_PATH: '/tmp/elsewhere.sqlite',
    });
    expect(env).toEqual({
      ...DEFAULTS,
      DISCORD_TOKEN: 'token',
      ARGUS_STATUS_URL: 'https://status.example/health',
      NODE_ENV: 'production',
      ARGUS_WEBHOOK_HOST: '0.0.0.0',
      ARGUS_WEBHOOK_PORT: '8080',
      D1_BRIDGE_URL: 'http://d1.internal',
    });
  });

  it('reports missing required settings', () => {
    expect(missingRequired(containerEnv({}))).toEqual([...REQUIRED]);
    const all = Object.fromEntries(REQUIRED.map((key) => [key, 'x']));
    expect(missingRequired(containerEnv(all))).toEqual([]);
  });

  it('fingerprints configuration independent of key order', async () => {
    const a = await envFingerprint({ A: '1', B: '2' });
    expect(await envFingerprint({ B: '2', A: '1' })).toBe(a);
    expect(await envFingerprint({ A: '1', B: '3' })).not.toBe(a);
  });

  it('uploads only known settings from GitHub, secrets winning over variables', () => {
    expect(
      workerSecrets({ ARGUS_TIMEZONE: 'America/Denver', DISCORD_TOKEN: 'from-var' }, { DISCORD_TOKEN: 'from-secret', CLOUDFLARE_API_TOKEN: 'never', LOG_LEVEL: ' ' }),
    ).toEqual({ ARGUS_TIMEZONE: 'America/Denver', DISCORD_TOKEN: 'from-secret' });
  });

  it('runs one container instance with its D1 database and a keep-alive cron', () => {
    const config = wranglerConfig();
    expect(config.containers).toEqual([expect.objectContaining({ class_name: 'ArgusBot', max_instances: 1, image: '../../bots/argus/Dockerfile' })]);
    expect(config.durable_objects.bindings).toEqual([{ name: 'ARGUS_BOT', class_name: 'ArgusBot' }]);
    expect(config.d1_databases[0]).toMatchObject({ binding: 'DB' });
    expect(config.d1_databases[0]!.database_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(config.triggers.crons).toEqual(['*/5 * * * *']);
  });
});
