/**
 * How the Argus bot runs on Cloudflare. Pure data and helpers, no Workers APIs, so it is
 * unit-tested with the rest of the repo. Shaped like the Ops bot's deploy/cloudflare/src/bots.ts.
 */
import { D1_BRIDGE_URL } from '../../../packages/shared/src/d1-bridge.js';

/** One instance: two gateway connections would answer everything twice. */
export const INSTANCE_NAME = 'primary';

/** Port of the bot's webhook server inside the container. */
export const BOT_PORT = 8080;

/** Public paths the Worker forwards to the bot (bots/argus/src/webhook/server.ts). */
export const BOT_PATHS = ['/healthz', '/webhooks/argus'] as const;

/**
 * Settings copied from Worker secrets into the container: every .env.example key except those the
 * deployment fixes (database, webhook listener) or that need a shared disk (CERTA_DB_PATH).
 * A test keeps this in sync with .env.example.
 */
export const ENV_KEYS = [
  'LOG_LEVEL',
  'DISCORD_TOKEN',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'ARGUS_CLIENT',
  'ARGUS_API_BASE_URL',
  'ARGUS_API_TOKEN',
  'ARGUS_STATUS_URL',
  'ARGUS_APP_URL',
  'ARGUS_TIMEZONE',
  'ARGUS_WEBHOOK_SECRET',
  'ARGUS_EVENT_ROUTES',
  'ARGUS_STATUS_CHANNEL_ID',
  'ARGUS_STATUS_ROLE_ID',
  'ARGUS_STATUS_POLL_SECONDS',
  'ARGUS_STATUS_CONFIRMATIONS',
  'ARGUS_SUPPORT_CHANNEL_ID',
  'ARGUS_STAFF_ROLE_ID',
  'ARGUS_TICKET_MODE',
  'ARGUS_TICKET_CATEGORY_ID',
  'ARGUS_TICKET_ARCHIVE_CHANNEL_ID',
  'ARGUS_SUPPORT_URL',
  'ARGUS_FAQ_PATH',
] as const;

/** Production values used when the setting is not set on the Worker. */
export const DEFAULTS: Record<string, string> = {
  ARGUS_CLIENT: 'http',
  ARGUS_API_BASE_URL: 'https://arkhonindustries.com/api/bot',
  ARGUS_STATUS_URL: 'https://arkhonindustries.com/api/health',
};

/**
 * Settings the bot cannot run without here. The webhook secret is required because the webhook
 * server is also the container's /healthz, which the Worker uses to start and watch it.
 */
export const REQUIRED = ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'ARGUS_API_TOKEN', 'ARGUS_WEBHOOK_SECRET'] as const;

export function isBotPath(pathname: string): boolean {
  return (BOT_PATHS as readonly string[]).includes(pathname);
}

/** The container's environment: set Worker values, then defaults, then fixed values. */
export function containerEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { ...DEFAULTS };
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  out.NODE_ENV = 'production';
  out.ARGUS_WEBHOOK_HOST = '0.0.0.0';
  out.ARGUS_WEBHOOK_PORT = String(BOT_PORT);
  out.D1_BRIDGE_URL = D1_BRIDGE_URL;
  return out;
}

export function missingRequired(env: Record<string, string>): string[] {
  return REQUIRED.filter((key) => !env[key]);
}

/** Fingerprint of a container environment, to restart the bot when the Worker's settings change. */
export async function envFingerprint(env: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(Object.keys(env).sort().map((key) => [key, env[key]]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Worker secrets to upload from GitHub secrets/variables: known keys with values, later sources win. */
export function workerSecrets(...sources: Record<string, unknown>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const key of ENV_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.trim() !== '') out[key] = value;
    }
  }
  return out;
}
