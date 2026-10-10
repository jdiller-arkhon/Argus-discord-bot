import { PermissionFlagsBits } from 'discord.js';
import type { ArgusEnv } from '../config.js';

// Setup checks for `pnpm argus:doctor`: does each credential and ID in the
// environment actually work? Pure apart from the injected fetch, so it is
// tested without Discord or Argus.

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const DISCORD_API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 10_000;

/**
 * Everything the bot does in a server:
 * - reads and posts in channels and threads, with embeds and files;
 * - opens private ticket threads, or private channels as the fallback, and
 *   locks them on close;
 * - pings the status role.
 */
export const BOT_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.MentionEveryone,
].reduce((all, flag) => all | flag, 0n);

/** The OAuth2 link that adds the bot to a server with the permissions above and slash commands. */
export function inviteUrl(applicationId: string, guildId?: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot applications.commands',
    permissions: BOT_PERMISSIONS.toString(),
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function get(fetchFn: Fetch, url: string, headers: Record<string, string>): Promise<Response | Error> {
  try {
    return await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function checkDiscordToken(env: ArgusEnv, fetchFn: Fetch): Promise<CheckResult> {
  const name = 'Discord bot token';
  const res = await get(fetchFn, `${DISCORD_API}/applications/@me`, { authorization: `Bot ${env.DISCORD_TOKEN}` });
  if (res instanceof Error) return { name, status: 'fail', detail: `Could not reach Discord: ${res.message}` };
  if (res.status === 401) {
    return { name, status: 'fail', detail: 'Discord rejected DISCORD_TOKEN. Reset the token on the Bot page and copy it again.' };
  }
  if (!res.ok) return { name, status: 'fail', detail: `Discord answered HTTP ${res.status}.` };
  const app = (await res.json().catch(() => null)) as { id?: string; name?: string } | null;
  if (app?.id && app.id !== env.DISCORD_APPLICATION_ID) {
    return {
      name,
      status: 'fail',
      detail: `The token belongs to application ${app.id}, but DISCORD_APPLICATION_ID is ${env.DISCORD_APPLICATION_ID}.`,
    };
  }
  return { name, status: 'pass', detail: `Signs in as the "${app?.name ?? 'unknown'}" application.` };
}

async function checkGuild(env: ArgusEnv, fetchFn: Fetch): Promise<CheckResult> {
  const name = 'Server';
  if (!env.DISCORD_GUILD_ID) {
    return {
      name,
      status: 'warn',
      detail: 'DISCORD_GUILD_ID is not set, so commands register globally and can take up to an hour to appear.',
    };
  }
  const res = await get(fetchFn, `${DISCORD_API}/guilds/${env.DISCORD_GUILD_ID}`, {
    authorization: `Bot ${env.DISCORD_TOKEN}`,
  });
  if (res instanceof Error) return { name, status: 'fail', detail: `Could not reach Discord: ${res.message}` };
  if (res.status === 403 || res.status === 404) {
    return {
      name,
      status: 'fail',
      detail: `The bot is not in server ${env.DISCORD_GUILD_ID}. Invite it: ${inviteUrl(env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID)}`,
    };
  }
  if (!res.ok) return { name, status: 'fail', detail: `Discord answered HTTP ${res.status}.` };
  const guild = (await res.json().catch(() => null)) as { name?: string } | null;
  return { name, status: 'pass', detail: `The bot is in "${guild?.name ?? env.DISCORD_GUILD_ID}".` };
}

/** Every channel ID in the environment, with the variable that names it. */
export function configuredChannels(env: ArgusEnv): { variable: string; id: string }[] {
  const channels: { variable: string; id: string }[] = [];
  const add = (variable: string, id: string | undefined) => {
    if (id) channels.push({ variable, id });
  };
  add('ARGUS_STATUS_CHANNEL_ID', env.ARGUS_STATUS_CHANNEL_ID);
  add('ARGUS_SUPPORT_CHANNEL_ID', env.ARGUS_SUPPORT_CHANNEL_ID);
  add('ARGUS_TICKET_ARCHIVE_CHANNEL_ID', env.ARGUS_TICKET_ARCHIVE_CHANNEL_ID);
  add('ARGUS_TICKET_CATEGORY_ID', env.ARGUS_TICKET_CATEGORY_ID);
  for (const [type, id] of Object.entries(env.ARGUS_EVENT_ROUTES)) add(`ARGUS_EVENT_ROUTES (${type})`, id);
  return channels;
}

async function checkChannel(env: ArgusEnv, fetchFn: Fetch, variable: string, id: string): Promise<CheckResult> {
  const name = variable;
  const res = await get(fetchFn, `${DISCORD_API}/channels/${id}`, { authorization: `Bot ${env.DISCORD_TOKEN}` });
  if (res instanceof Error) return { name, status: 'fail', detail: `Could not reach Discord: ${res.message}` };
  if (res.status === 403 || res.status === 404) {
    return {
      name,
      status: 'fail',
      detail: `The bot can't see channel ${id}. Check the ID, and give the bot's role View Channel there.`,
    };
  }
  if (!res.ok) return { name, status: 'fail', detail: `Discord answered HTTP ${res.status}.` };
  const channel = (await res.json().catch(() => null)) as { name?: string } | null;
  return { name, status: 'pass', detail: `#${channel?.name ?? id}` };
}

async function checkArgusApi(env: ArgusEnv, fetchFn: Fetch): Promise<CheckResult> {
  const name = 'Argus API';
  if (env.ARGUS_CLIENT === 'mock') {
    return { name, status: 'warn', detail: 'ARGUS_CLIENT=mock: the bot shows sample data, not Argus. Set it to http.' };
  }
  const base = (env.ARGUS_API_BASE_URL ?? '').replace(/\/+$/, '');
  const res = await get(fetchFn, `${base}/v1/status`, { authorization: `Bearer ${env.ARGUS_API_TOKEN ?? ''}` });
  if (res instanceof Error) return { name, status: 'fail', detail: `Could not reach ${base}: ${res.message}` };
  if (res.status === 401) {
    return {
      name,
      status: 'fail',
      detail:
        'Argus rejected ARGUS_API_TOKEN. It must equal DISCORD_BOT_API_TOKEN in the website’s Cloudflare settings, and that must be set.',
    };
  }
  if (res.status === 404) {
    return { name, status: 'fail', detail: `${base}/v1/status was not found. ARGUS_API_BASE_URL should end in /api/bot.` };
  }
  if (!res.ok) return { name, status: 'fail', detail: `Argus answered HTTP ${res.status}.` };
  const body = (await res.json().catch(() => null)) as { state?: string } | null;
  return { name, status: 'pass', detail: `Connected. Argus reports "${body?.state ?? 'unknown'}".` };
}

function checkWebhook(env: ArgusEnv): CheckResult {
  const name = 'Event webhook';
  if (!env.ARGUS_WEBHOOK_SECRET) {
    return {
      name,
      status: 'warn',
      detail: 'ARGUS_WEBHOOK_SECRET is not set, so the bot gets no alerts from Argus (no DMs, no live status).',
    };
  }
  return {
    name,
    status: 'pass',
    detail:
      'ARGUS_WEBHOOK_SECRET is set. To check that Argus signs with the same secret and can reach the bot, use Admin console → Pilot Network → Bot connection on the website.',
  };
}

async function checkPublicUrl(publicUrl: string, fetchFn: Fetch): Promise<CheckResult> {
  const name = 'Public address';
  const url = `${publicUrl.replace(/\/+$/, '')}/healthz`;
  const res = await get(fetchFn, url, {});
  if (res instanceof Error) return { name, status: 'fail', detail: `Could not reach ${url}: ${res.message}` };
  if (res.status === 503) return { name, status: 'warn', detail: `${url} answers, but the bot isn't connected to Discord yet.` };
  if (!res.ok) return { name, status: 'fail', detail: `${url} answered HTTP ${res.status}.` };
  return { name, status: 'pass', detail: `${url} is up and the bot is connected to Discord.` };
}

/** Runs every check that applies to `env`. `publicUrl` is where Argus will send events, if known. */
export async function runChecks(env: ArgusEnv, fetchFn: Fetch, publicUrl?: string): Promise<CheckResult[]> {
  const token = await checkDiscordToken(env, fetchFn);
  const results = [token];
  // Without a working token every other Discord call fails the same way.
  if (token.status === 'pass') {
    results.push(await checkGuild(env, fetchFn));
    for (const { variable, id } of configuredChannels(env)) results.push(await checkChannel(env, fetchFn, variable, id));
  }
  results.push(await checkArgusApi(env, fetchFn));
  results.push(checkWebhook(env));
  if (publicUrl) results.push(await checkPublicUrl(publicUrl, fetchFn));
  return results;
}
