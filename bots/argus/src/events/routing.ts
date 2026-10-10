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
  | { kind: 'dm'; discordUserId: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'drop'; reason: string };

export interface RoutingInput {
  /** Channel per event type, from `ARGUS_EVENT_ROUTES`. */
  routes: Partial<Record<ArgusEventType, string>>;
  /** Linked Discord user for `event.userId`, or undefined when not linked. */
  owner?: { discordUserId: string; disabledAlerts: ReadonlySet<string> };
}

/**
 * Decides where an event goes. Rules:
 *
 * 1. Service status changes go to the status monitor.
 * 2. An event that belongs to a user (`userId` set) is only ever DMed to that
 *    user, never posted to a channel, because it describes their own jobs,
 *    money, or credentials. It is dropped if they are not linked or have
 *    turned that alert type off.
 * 3. Broadcast events (`userId` null) go to the channel configured for their
 *    type, or are dropped when none is configured.
 */
export function routeEvent(event: ArgusEvent, input: RoutingInput): EventRoute {
  if (event.type === 'service.status_changed') return { kind: 'status' };

  if (event.userId !== null) {
    if (!input.owner) return { kind: 'drop', reason: 'owner not linked' };
    if (!isAlertEnabled(input.owner.disabledAlerts, event.type)) return { kind: 'drop', reason: 'alert turned off by user' };
    return { kind: 'dm', discordUserId: input.owner.discordUserId };
  }

  const channelId = input.routes[event.type];
  return channelId ? { kind: 'channel', channelId } : { kind: 'drop', reason: `no channel configured for ${event.type}` };
}

/** Personal alerts are on unless the user turned the type off. */
export function isAlertEnabled(disabled: ReadonlySet<string>, type: ArgusEventType): boolean {
  return !disabled.has(type);
}

/**
 * Turns the values picked in the `/argus alerts` select menu into on/off
 * preferences for every alert that was shown. Alerts not shown (other roles)
 * are left untouched; unknown values are ignored.
 */
export function alertPreferencesFromSelection(
  selected: readonly string[],
  shown: readonly Pick<PersonalAlert, 'type'>[],
): Partial<Record<PersonalAlertType, boolean>> {
  const chosen = new Set(selected.filter(isPersonalAlertType));
  return Object.fromEntries(shown.map((alert) => [alert.type, chosen.has(alert.type)]));
}

/** Of the given alerts, the types currently on for a user, in menu order. */
export function enabledAlerts(
  disabled: ReadonlySet<string>,
  alerts: readonly Pick<PersonalAlert, 'type'>[] = PERSONAL_ALERTS,
): PersonalAlertType[] {
  return alerts.filter((alert) => isAlertEnabled(disabled, alert.type)).map((alert) => alert.type);
}
