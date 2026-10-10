import { type Logger, TtlCache } from '@arkhon/shared';
import type { ArgusClient } from './argus/client.js';
import { type BotSettings, DEFAULT_BOT_SETTINGS } from './argus/types.js';

/** How long a user's settings are reused before asking Argus again. */
export const SETTINGS_TTL_MS = 60_000;

export interface SettingsSource {
  /** The user's settings; the defaults if Argus cannot be reached, so alerts still flow. */
  get(argusUserId: string): Promise<BotSettings>;
  /** Saves through Argus and refreshes the cached copy. */
  update(argusUserId: string, settings: BotSettings): Promise<BotSettings>;
}

/**
 * Bot settings live on Argus (pilot portal → Discord bot, or `/argus alerts`).
 * Event delivery reads them per event, so they are cached briefly to avoid an
 * API call per DM; a change made on the website applies within a minute.
 */
export function createSettingsSource(argus: ArgusClient, logger: Logger, ttlMs = SETTINGS_TTL_MS): SettingsSource {
  const cache = new TtlCache<BotSettings>(ttlMs);
  return {
    async get(argusUserId) {
      try {
        return await cache.getOrLoad(argusUserId, () => argus.getBotSettings(argusUserId));
      } catch (error) {
        logger.warn('Could not load bot settings from Argus; using defaults', { argusUserId, error });
        return DEFAULT_BOT_SETTINGS;
      }
    },
    async update(argusUserId, settings) {
      const saved = await argus.updateBotSettings(argusUserId, settings);
      cache.set(argusUserId, saved);
      return saved;
    },
  };
}
