import type { Logger } from '@arkhon/shared';
import type { EmbedBuilder } from 'discord.js';
import type { ServiceStatus } from '../argus/types.js';
import type { SettingsSource } from '../settings.js';
import type { ArgusStore } from '../store.js';
import { formatEvent } from './format.js';
import { type EventRoute, routeEvent } from './routing.js';
import type { ArgusEvent, ArgusEventType } from './types.js';

export interface DispatchResult {
  route: EventRoute['kind'];
  /** False when the DM or channel post could not be sent (closed DMs, missing channel) or was held. */
  delivered: boolean;
  /** ISO time a held DM will be sent (the user's quiet hours end). */
  heldUntil?: string;
  reason?: string;
}

export interface EventDispatcherDeps {
  store: Pick<ArgusStore, 'getLinkByArgusId' | 'holdDm'>;
  settings: Pick<SettingsSource, 'get'>;
  routes: Partial<Record<ArgusEventType, string>>;
  sendDm(discordUserId: string, embed: EmbedBuilder): Promise<boolean>;
  postToChannel(channelId: string, embed: EmbedBuilder): Promise<boolean>;
  observeStatus(status: ServiceStatus): Promise<unknown>;
  now(): Date;
  todayIso(): string;
  logger: Logger;
}

/** Routes a verified Argus event and delivers (or holds) it. Thin glue over {@link routeEvent}. */
export function createEventDispatcher(deps: EventDispatcherDeps): (event: ArgusEvent) => Promise<DispatchResult> {
  return async (event) => {
    const link = event.userId ? deps.store.getLinkByArgusId(event.userId) : undefined;
    const now = deps.now();
    const route = routeEvent(event, {
      routes: deps.routes,
      owner: link ? { discordUserId: link.discordUserId, settings: await deps.settings.get(link.argusUserId) } : undefined,
      now,
    });

    switch (route.kind) {
      case 'status':
        // Narrowed by routeEvent: only service.status_changed routes here.
        await deps.observeStatus((event as Extract<ArgusEvent, { type: 'service.status_changed' }>).data);
        return { route: 'status', delivered: true };
      case 'drop':
        deps.logger.debug('Argus event dropped', { eventId: event.id, type: event.type, reason: route.reason });
        return { route: 'drop', delivered: false, reason: route.reason };
      case 'dm': {
        const embed = formatEvent(event, deps.todayIso());
        if (route.deliverAt) {
          deps.store.holdDm({ discordUserId: route.discordUserId, eventId: event.id, embed: embed.toJSON(), deliverAt: route.deliverAt }, now);
          return { route: 'dm', delivered: false, heldUntil: route.deliverAt.toISOString(), reason: 'quiet hours' };
        }
        const delivered = await deps.sendDm(route.discordUserId, embed);
        return { route: 'dm', delivered, reason: delivered ? undefined : 'user has DMs closed' };
      }
      case 'channel': {
        const delivered = await deps.postToChannel(route.channelId, formatEvent(event, deps.todayIso()));
        // A missing or unsendable channel is a configuration problem worth a retry.
        if (!delivered) throw new Error(`Could not post Argus event to channel ${route.channelId}`);
        return { route: 'channel', delivered };
      }
    }
  };
}
