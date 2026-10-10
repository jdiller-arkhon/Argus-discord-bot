import { fileURLToPath } from 'node:url';
import { csvList, loadEnv, snowflake } from '@arkhon/shared';
import { IANAZone } from 'luxon';
import { z } from 'zod';
import { type ArgusEventType, isEventType } from './events/types.js';

/** `type=channelId` pairs, e.g. `mission.posted=1234...,job.status_changed=5678...`. */
const eventRoutes = csvList.transform((pairs, ctx) => {
  const routes: Partial<Record<ArgusEventType, string>> = {};
  for (const pair of pairs) {
    const [type, channelId, extra] = pair.split('=').map((part) => part.trim());
    if (extra !== undefined || !type || !channelId) {
      ctx.addIssue({ code: 'custom', message: `"${pair}" must look like event.type=channelId` });
      continue;
    }
    if (!isEventType(type) || type === 'service.status_changed') {
      ctx.addIssue({ code: 'custom', message: `"${type}" is not a routable Argus event type` });
      continue;
    }
    if (!snowflake.safeParse(channelId).success) {
      ctx.addIssue({ code: 'custom', message: `"${channelId}" is not a Discord channel ID` });
      continue;
    }
    routes[type] = channelId;
  }
  return routes;
});

const port = z.coerce.number().int().min(0).max(65_535);

export const argusEnvSchema = z
  .object({
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: snowflake,
    /** When set, commands are registered to this guild only (instant updates). */
    DISCORD_GUILD_ID: snowflake.optional(),

    ARGUS_CLIENT: z.enum(['http', 'mock']).default('http'),
    ARGUS_API_BASE_URL: z.string().url().optional(),
    ARGUS_API_TOKEN: z.string().min(1).optional(),
    /** Optional separate status endpoint (full status JSON, or the platform's `/api/health`). */
    ARGUS_STATUS_URL: z.string().url().optional(),
    /** Base URL of the Argus web app, for "open in Argus" links. */
    ARGUS_APP_URL: z.string().url().default('https://arkhonindustries.com/app'),
    ARGUS_DB_PATH: z.string().default('./data/argus.sqlite'),
    ARGUS_TIMEZONE: z
      .string()
      .default('America/Denver')
      .refine((zone) => IANAZone.isValidZone(zone), 'expected an IANA time zone, e.g. America/Denver'),

    /** Shared secret for `X-Argus-Signature`. The webhook server is off when unset. */
    ARGUS_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters').optional(),
    ARGUS_WEBHOOK_HOST: z.string().default('0.0.0.0'),
    ARGUS_WEBHOOK_PORT: port.default(8080),
    ARGUS_EVENT_ROUTES: eventRoutes.default(''),

    ARGUS_STATUS_CHANNEL_ID: snowflake.optional(),
    /** Role pinged only when the status becomes degraded or outage. */
    ARGUS_STATUS_ROLE_ID: snowflake.optional(),
    /** Seconds between status polls; 0 turns polling off (webhook updates still post). */
    ARGUS_STATUS_POLL_SECONDS: z.coerce.number().int().min(0).default(60),
    /** Consecutive polls that must agree before a change is announced. */
    ARGUS_STATUS_CONFIRMATIONS: z.coerce.number().int().min(1).max(10).default(2),

    ARGUS_SUPPORT_CHANNEL_ID: snowflake.optional(),
    ARGUS_STAFF_ROLE_ID: snowflake.optional(),
    ARGUS_TICKET_MODE: z.enum(['thread', 'channel']).default('thread'),
    ARGUS_TICKET_CATEGORY_ID: snowflake.optional(),
    ARGUS_TICKET_ARCHIVE_CHANNEL_ID: snowflake.optional(),
    /** Shown in `/argus help` when Discord tickets are not configured. */
    ARGUS_SUPPORT_URL: z.string().url().default('https://arkhonindustries.com/contact'),
    /** JSON FAQ file; defaults to bots/argus/faq.json. */
    ARGUS_FAQ_PATH: z.string().optional(),

    /** Certa bot's SQLite file, opened read-only to tell users they are linked to both. */
    CERTA_DB_PATH: z.string().optional(),

    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((env, ctx) => {
    if (env.ARGUS_CLIENT === 'http') {
      if (!env.ARGUS_API_BASE_URL) {
        ctx.addIssue({ code: 'custom', path: ['ARGUS_API_BASE_URL'], message: 'required when ARGUS_CLIENT=http' });
      }
      if (!env.ARGUS_API_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['ARGUS_API_TOKEN'], message: 'required when ARGUS_CLIENT=http' });
      }
    }
    if (Boolean(env.ARGUS_SUPPORT_CHANNEL_ID) !== Boolean(env.ARGUS_STAFF_ROLE_ID)) {
      const missing = env.ARGUS_SUPPORT_CHANNEL_ID ? 'ARGUS_STAFF_ROLE_ID' : 'ARGUS_SUPPORT_CHANNEL_ID';
      ctx.addIssue({ code: 'custom', path: [missing], message: 'set ARGUS_SUPPORT_CHANNEL_ID and ARGUS_STAFF_ROLE_ID together' });
    }
  });

export type ArgusEnv = z.infer<typeof argusEnvSchema>;

export interface TicketSettings {
  supportChannelId: string;
  staffRoleId: string;
  mode: 'thread' | 'channel';
  categoryId?: string;
  archiveChannelId?: string;
}

export interface ArgusConfig {
  env: ArgusEnv;
  timezone: string;
  faqPath: string;
  /** Null when Discord support tickets are not configured. */
  tickets: TicketSettings | null;
}

export const DEFAULT_FAQ_PATH = fileURLToPath(new URL('../faq.json', import.meta.url));

export function loadArgusConfig(source: Record<string, string | undefined> = process.env): ArgusConfig {
  const env = loadEnv(argusEnvSchema, source);
  return {
    env,
    timezone: env.ARGUS_TIMEZONE,
    faqPath: env.ARGUS_FAQ_PATH ?? DEFAULT_FAQ_PATH,
    tickets:
      env.ARGUS_SUPPORT_CHANNEL_ID && env.ARGUS_STAFF_ROLE_ID
        ? {
            supportChannelId: env.ARGUS_SUPPORT_CHANNEL_ID,
            staffRoleId: env.ARGUS_STAFF_ROLE_ID,
            mode: env.ARGUS_TICKET_MODE,
            categoryId: env.ARGUS_TICKET_CATEGORY_ID,
            archiveChannelId: env.ARGUS_TICKET_ARCHIVE_CHANNEL_ID,
          }
        : null,
  };
}
