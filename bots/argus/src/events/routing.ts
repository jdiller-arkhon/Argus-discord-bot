import { DateTime } from 'luxon';
import type { BotSettings } from '../argus/types.js';
import {
  type ArgusEvent,
  type ArgusEventType,
  isPersonalAlertType,
  PERSONAL_ALERTS,
  type PersonalAlert,
  type PersonalAlertType,
} from './types.js';

export type EventRoute =
  /** Handled by the status monitor (posts to the status channel). */
  | { kind: 'status' }
  /** DM now, or at `deliverAt` when the user is in quiet hours. */
  | { kind: 'dm'; discordUserId: string; deliverAt?: Date }
  | { kind: 'channel'; channelId: string }
  | { kind: 'drop'; reason: string };

export interface RoutingInput {
  /** Channel per event type, from `ARGUS_EVENT_ROUTES`. */
  routes: Partial<Record<ArgusEventType, string>>;
  /** Linked Discord user for `event.userId` and their bot settings from Argus; undefined when not linked. */
  owner?: { discordUserId: string; settings: BotSettings };
  now: Date;
}

/** Alerts that skip quiet hours when the user allows urgent alerts: money or a dispute needing action. */
export const URGENT_ALERTS: readonly ArgusEventType[] = ['payout.failed', 'dispute.updated'];

/**
 * Decides where an event goes. Rules:
 *
 * 1. Service status changes go to the status monitor.
 * 2. An event that belongs to a user (`userId` set) is only ever DMed to that
 *    user, never posted to a channel, because it describes their own jobs,
 *    money, or credentials. It is dropped if they are not linked, turned that
 *    alert off, or (new missions) it falls outside their payout or distance
 *    filter. During their quiet hours it is held until quiet hours end, unless
 *    it is urgent and they let urgent alerts through.
 * 3. Broadcast events (`userId` null) go to the channel configured for their
 *    type, or are dropped when none is configured.
 *
 * The settings come from Argus (pilot portal → Discord bot, or `/argus alerts`).
 */
export function routeEvent(event: ArgusEvent, input: RoutingInput): EventRoute {
  if (event.type === 'service.status_changed') return { kind: 'status' };

  if (event.userId !== null) {
    if (!input.owner) return { kind: 'drop', reason: 'owner not linked' };
    const { settings, discordUserId } = input.owner;
    if (!isAlertEnabled(new Set(settings.disabledAlerts), event.type)) {
      return { kind: 'drop', reason: 'alert turned off by user' };
    }
    // Requested by the user on the website: no settings apply.
    if (event.type === 'account.test') return { kind: 'dm', discordUserId };
    if (event.type === 'mission.posted') {
      const { minPayoutCents, maxDistanceMi, serviceTypes } = settings.missionAlerts;
      if (serviceTypes.length > 0 && event.data.serviceId !== null && !serviceTypes.includes(event.data.serviceId)) {
        return { kind: 'drop', reason: 'not one of the user’s services' };
      }
      if (minPayoutCents !== null && event.data.payoutCents < minPayoutCents) {
        return { kind: 'drop', reason: 'below the user’s minimum payout' };
      }
      if (maxDistanceMi !== null && event.data.distanceMi !== null && event.data.distanceMi > maxDistanceMi) {
        return { kind: 'drop', reason: 'outside the user’s distance limit' };
      }
    }
    const urgentPasses = settings.quietHours.allowUrgent && URGENT_ALERTS.includes(event.type);
    const quietUntil = urgentPasses ? null : quietHoursEnd(settings.quietHours, settings.timezone, input.now);
    return quietUntil ? { kind: 'dm', discordUserId, deliverAt: quietUntil } : { kind: 'dm', discordUserId };
  }

  const channelId = input.routes[event.type];
  return channelId ? { kind: 'channel', channelId } : { kind: 'drop', reason: `no channel configured for ${event.type}` };
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * When the user's quiet hours end, if `now` is inside them; otherwise null.
 * Handles overnight ranges (22:00–07:00) and DST via the user's time zone. An
 * unknown zone or equal start/end means "no quiet hours" rather than "always quiet".
 */
export function quietHoursEnd(quiet: BotSettings['quietHours'], timezone: string, now: Date): Date | null {
  if (!quiet.enabled || quiet.start === quiet.end) return null;
  const local = DateTime.fromJSDate(now).setZone(timezone);
  if (!local.isValid) return null;
  const current = local.hour * 60 + local.minute;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const inside = start < end ? current >= start && current < end : current >= start || current < end;
  if (!inside) return null;

  let endAt = local.set({ hour: Math.floor(end / 60), minute: end % 60, second: 0, millisecond: 0 });
  if (endAt <= local) endAt = endAt.plus({ days: 1 });
  return endAt.toJSDate();
}

/** Personal alerts are on unless the user turned the type off. */
export function isAlertEnabled(disabled: ReadonlySet<string>, type: ArgusEventType): boolean {
  return !disabled.has(type);
}

/**
 * New `disabledAlerts` after the user picks alerts in the `/argus alerts`
 * menu: shown alerts follow the selection; alerts not shown (other roles) keep
 * their current setting; unknown values are ignored.
 */
export function disabledAfterSelection(
  current: readonly string[],
  selected: readonly string[],
  shown: readonly Pick<PersonalAlert, 'type'>[],
): PersonalAlertType[] {
  const chosen = new Set(selected.filter(isPersonalAlertType));
  const shownTypes = new Set<string>(shown.map((alert) => alert.type));
  const keep = current.filter((type): type is PersonalAlertType => isPersonalAlertType(type) && !shownTypes.has(type));
  const off = shown.filter((alert) => !chosen.has(alert.type)).map((alert) => alert.type);
  return PERSONAL_ALERTS.map((a) => a.type).filter((type) => keep.includes(type) || off.includes(type));
}

/** Of the given alerts, the types currently on for a user, in menu order. */
export function enabledAlerts(
  disabled: ReadonlySet<string>,
  alerts: readonly Pick<PersonalAlert, 'type'>[] = PERSONAL_ALERTS,
): PersonalAlertType[] {
  return alerts.filter((alert) => isAlertEnabled(disabled, alert.type)).map((alert) => alert.type);
}
