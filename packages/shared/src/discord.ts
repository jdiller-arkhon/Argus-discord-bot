import { type Client, type EmbedBuilder, type SendableChannels } from 'discord.js';
import type { Logger } from './logger.js';

/** Brand colors shared across Arkhon bots. */
export const Colors = {
  primary: 0x1f6feb,
  success: 0x2ea043,
  warning: 0xd29922,
  danger: 0xcf222e,
  neutral: 0x6e7681,
} as const;

/**
 * Fetches a text channel by ID and posts embeds to it (max 10 per message).
 * Returns false (and logs) instead of throwing when the channel is missing or
 * not sendable, so scheduled jobs can continue.
 */
export async function postEmbeds(
  client: Client,
  channelId: string,
  embeds: EmbedBuilder[],
  logger: Logger,
  content?: string,
): Promise<boolean> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isSendable()) {
    logger.warn('Channel missing or not sendable', { channelId });
    return false;
  }
  const sendable: SendableChannels = channel;
  for (let i = 0; i < Math.max(embeds.length, 1); i += 10) {
    await sendable.send({ content: i === 0 ? content : undefined, embeds: embeds.slice(i, i + 10) });
  }
  return true;
}

/** Sends a DM; returns false when the user has DMs closed or cannot be fetched. */
export async function sendDm(
  client: Client,
  userId: string,
  message: { content?: string; embeds?: EmbedBuilder[] },
  logger: Logger,
): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(message);
    return true;
  } catch (error) {
    logger.warn('Could not DM user', { userId, error });
    return false;
  }
}
