import type { Logger } from '@arkhon/shared';
import { EmbedBuilder } from 'discord.js';
import type { ArgusStore } from '../store.js';

export interface HeldDmResult {
  sent: number;
  dropped: number;
}

/**
 * Sends DMs held for quiet hours whose time has come. A DM the user cannot
 * receive (closed DMs, left the server) is dropped rather than retried
 * forever; an unexpected error leaves it for the next run.
 */
export async function deliverHeldDms(
  store: Pick<ArgusStore, 'dueHeldDms' | 'deleteHeldDm'>,
  send: (discordUserId: string, embed: EmbedBuilder) => Promise<boolean>,
  logger: Logger,
  now: Date = new Date(),
): Promise<HeldDmResult> {
  const result: HeldDmResult = { sent: 0, dropped: 0 };
  for (const dm of await store.dueHeldDms(now)) {
    try {
      const delivered = await send(dm.discordUserId, EmbedBuilder.from(dm.embed as never));
      await store.deleteHeldDm(dm.id);
      if (delivered) result.sent++;
      else {
        result.dropped++;
        logger.info('Held DM dropped: user cannot receive DMs', { discordUserId: dm.discordUserId, eventId: dm.eventId });
      }
    } catch (error) {
      logger.warn('Held DM delivery failed; will retry', { id: dm.id, error });
    }
  }
  return result;
}

/** Checks for due held DMs every `intervalMs`. Returns a stop function. */
export function startHeldDmDelivery(
  store: Pick<ArgusStore, 'dueHeldDms' | 'deleteHeldDm'>,
  send: (discordUserId: string, embed: EmbedBuilder) => Promise<boolean>,
  logger: Logger,
  intervalMs = 60_000,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await deliverHeldDms(store, send, logger);
      if (result.sent + result.dropped > 0) logger.info('Delivered held DMs', { ...result });
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
