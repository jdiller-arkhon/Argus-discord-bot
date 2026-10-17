import type { Client } from 'discord.js';
import type { ServiceStatus } from '../argus/types.js';
import type { ArgusContext } from '../context.js';
import { STATE_LABELS, statusChangeEmbed } from '../embeds.js';
import { type StatusAnnouncement, StatusMonitor } from './monitor.js';
import { presenceFor } from './presence.js';

/** Message content for a status post; the role is pinged only for degraded/outage. */
export function announcementContent(announcement: StatusAnnouncement, roleId: string | undefined): string | undefined {
  if (!announcement.ping || !roleId) return undefined;
  return `<@&${roleId}> Argus is reporting **${STATE_LABELS[announcement.to].label.toLowerCase()}**.`;
}

/** Status monitor that posts confirmed changes to ARGUS_STATUS_CHANNEL_ID. */
export function createStatusMonitor(context: ArgusContext, client: Client): StatusMonitor {
  const { env } = context.config;
  return new StatusMonitor({
    load: () => context.store.getStatusMemory(),
    save: (memory) => context.store.saveStatusMemory(memory),
    pollConfirmations: env.ARGUS_STATUS_CONFIRMATIONS,
    logger: context.logger,
    async announce(announcement, status: ServiceStatus) {
      client.user?.setPresence(presenceFor(announcement.to));
      const channelId = env.ARGUS_STATUS_CHANNEL_ID;
      if (!channelId) {
        context.logger.info('Argus status changed (no ARGUS_STATUS_CHANNEL_ID, not posted)', { ...announcement });
        return;
      }
      const content = announcementContent(announcement, env.ARGUS_STATUS_ROLE_ID);
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) throw new Error(`Status channel ${channelId} is missing or not sendable`);
      await channel.send({
        content,
        embeds: [statusChangeEmbed(announcement.from, status)],
        allowedMentions: { roles: content && env.ARGUS_STATUS_ROLE_ID ? [env.ARGUS_STATUS_ROLE_ID] : [] },
      });
    },
  });
}

/**
 * Polls Argus every ARGUS_STATUS_POLL_SECONDS and feeds the monitor. Poll
 * failures are logged and skipped; an unreachable status *endpoint* is
 * reported by the client as an outage. Returns a stop function.
 */
export function startStatusPolling(context: ArgusContext, monitor: StatusMonitor): () => void {
  const seconds = context.config.env.ARGUS_STATUS_POLL_SECONDS;
  if (seconds === 0) {
    context.logger.info('Argus status polling disabled (ARGUS_STATUS_POLL_SECONDS=0)');
    return () => {};
  }
  let running = false;
  const poll = async () => {
    if (running) return;
    running = true;
    try {
      await monitor.observe(await context.argus.getServiceStatus(), 'poll');
    } catch (error) {
      context.logger.warn('Argus status poll failed', { error });
    } finally {
      running = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), seconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
