import { silentLogger } from '@arkhon/shared';
import type { EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { type BotSettings, DEFAULT_BOT_SETTINGS } from '../src/argus/types.js';
import { decodeDisabled, encodeDisabled } from '../src/commands/alerts.js';
import { openArgusDatabase } from '../src/db.js';
import { createEventDispatcher } from '../src/events/dispatch.js';
import { deliverHeldDms } from '../src/events/held.js';
import { disabledAfterSelection, enabledAlerts, isAlertEnabled, quietHoursEnd, routeEvent } from '../src/events/routing.js';
import { sampleEvent } from '../src/events/samples.js';
import { alertsForRole, EVENT_TYPES, PERSONAL_ALERTS } from '../src/events/types.js';
import { ArgusStore } from '../src/store.js';
import { USER } from './fixtures.js';

const CHANNEL = '400000000000000001';
const routes = { 'mission.posted': CHANNEL };
// Noon in Denver: outside default-style overnight quiet hours.
const NOON = new Date('2026-10-10T18:00:00Z');
const settings = (patch: Partial<BotSettings> = {}): BotSettings => ({ ...DEFAULT_BOT_SETTINGS, ...patch });
const owner = (patch: Partial<BotSettings> = {}) => ({ discordUserId: USER, settings: settings(patch) });
const quiet = (patch: Partial<BotSettings['quietHours']> = {}, timezone = 'America/Denver'): Partial<BotSettings> => ({
  timezone,
  quietHours: { enabled: true, start: '22:00', end: '07:00', allowUrgent: true, ...patch },
});

describe('routeEvent', () => {
  it('sends service status changes to the status monitor, ignoring routes and owners', () => {
    expect(routeEvent(sampleEvent('service.status_changed'), { routes, owner: owner(), now: NOON })).toEqual({ kind: 'status' });
  });

  it('DMs the linked owner of a personal event', () => {
    for (const type of EVENT_TYPES.filter((t) => t !== 'service.status_changed')) {
      expect(routeEvent(sampleEvent(type, { userId: 'argus-1' }), { routes, owner: owner(), now: NOON })).toEqual({
        kind: 'dm',
        discordUserId: USER,
      });
    }
  });

  it('never posts a personal event to a channel, even when its type has a route', () => {
    const event = sampleEvent('mission.posted', { userId: 'argus-1' });
    expect(routeEvent(event, { routes, now: NOON })).toEqual({ kind: 'drop', reason: 'owner not linked' });
    expect(routeEvent(event, { routes, owner: owner({ disabledAlerts: ['mission.posted'] }), now: NOON })).toEqual({
      kind: 'drop',
      reason: 'alert turned off by user',
    });
  });

  it('posts broadcast events to their configured channel, or drops them', () => {
    expect(routeEvent(sampleEvent('mission.posted'), { routes, now: NOON })).toEqual({ kind: 'channel', channelId: CHANNEL });
    expect(routeEvent(sampleEvent('job.status_changed'), { routes, now: NOON })).toEqual({
      kind: 'drop',
      reason: 'no channel configured for job.status_changed',
    });
  });

  it('only mutes the alert type the user turned off', () => {
    const muted = owner({ disabledAlerts: ['payout.paid'] });
    expect(routeEvent(sampleEvent('payout.paid', { userId: 'a' }), { routes, owner: muted, now: NOON }).kind).toBe('drop');
    expect(routeEvent(sampleEvent('payout.failed', { userId: 'a' }), { routes, owner: muted, now: NOON }).kind).toBe('dm');
  });

  it('applies the mission payout and distance filters', () => {
    // The sample mission pays $180 and is 12.4 mi away.
    const mission = sampleEvent('mission.posted', { userId: 'a' });
    const route = (minPayoutCents: number | null, maxDistanceMi: number | null) =>
      routeEvent(mission, { routes, owner: owner({ missionAlerts: { minPayoutCents, maxDistanceMi, serviceTypes: [] } }), now: NOON });
    expect(route(18_000, 13).kind).toBe('dm');
    expect(route(18_001, null)).toEqual({ kind: 'drop', reason: 'below the user’s minimum payout' });
    expect(route(null, 12)).toEqual({ kind: 'drop', reason: 'outside the user’s distance limit' });
    // An unknown distance is not filtered out.
    const noDistance = { ...mission, data: { ...mission.data, distanceMi: null } } as typeof mission;
    expect(routeEvent(noDistance, { routes, owner: owner({ missionAlerts: { minPayoutCents: null, maxDistanceMi: 5, serviceTypes: [] } }), now: NOON }).kind).toBe('dm');
    // Filters only apply to missions.
    expect(routeEvent(sampleEvent('payout.paid', { userId: 'a' }), { routes, owner: owner({ missionAlerts: { minPayoutCents: 999_999, maxDistanceMi: 1, serviceTypes: ['roof'] } }), now: NOON }).kind).toBe('dm');
  });

  it('filters missions by service and always delivers test DMs', () => {
    const mission = sampleEvent('mission.posted', { userId: 'a' }); // serviceId 'realestate'
    const only = (serviceTypes: string[]) =>
      routeEvent(mission, { routes, owner: owner({ missionAlerts: { minPayoutCents: null, maxDistanceMi: null, serviceTypes } }), now: NOON });
    expect(only([]).kind).toBe('dm');
    expect(only(['realestate', 'roof']).kind).toBe('dm');
    expect(only(['roof'])).toEqual({ kind: 'drop', reason: 'not one of the user’s services' });

    const night = new Date('2026-10-11T05:00:00Z');
    const everythingOff = owner({ ...quiet({ allowUrgent: false }), disabledAlerts: PERSONAL_ALERTS.map((a) => a.type) });
    expect(routeEvent(sampleEvent('account.test', { userId: 'a' }), { routes, owner: everythingOff, now: night })).toEqual({
      kind: 'dm',
      discordUserId: USER,
    });
    // The digest is not a toggleable alert, but it does wait out quiet hours.
    expect(routeEvent(sampleEvent('digest.daily', { userId: 'a' }), { routes, owner: everythingOff, now: night })).toMatchObject({
      kind: 'dm',
      deliverAt: new Date('2026-10-11T13:00:00Z'),
    });
  });

  it('holds DMs during quiet hours until they end, letting urgent ones through', () => {
    const night = new Date('2026-10-11T05:00:00Z'); // 23:00 in Denver (MDT)
    const held = routeEvent(sampleEvent('payout.paid', { userId: 'a' }), { routes, owner: owner(quiet()), now: night });
    expect(held).toEqual({ kind: 'dm', discordUserId: USER, deliverAt: new Date('2026-10-11T13:00:00Z') });
    expect(routeEvent(sampleEvent('payout.failed', { userId: 'a' }), { routes, owner: owner(quiet()), now: night })).toEqual({
      kind: 'dm',
      discordUserId: USER,
    });
    const strict = routeEvent(sampleEvent('payout.failed', { userId: 'a' }), {
      routes,
      owner: owner(quiet({ allowUrgent: false })),
      now: night,
    });
    expect(strict).toMatchObject({ kind: 'dm', deliverAt: new Date('2026-10-11T13:00:00Z') });
    expect(routeEvent(sampleEvent('payout.paid', { userId: 'a' }), { routes, owner: owner(quiet()), now: NOON })).toEqual({
      kind: 'dm',
      discordUserId: USER,
    });
  });
});

describe('quietHoursEnd', () => {
  const quietHours = (patch: Partial<BotSettings['quietHours']> = {}) => ({ ...DEFAULT_BOT_SETTINGS.quietHours, enabled: true, ...patch });

  it('handles overnight ranges on both sides of midnight', () => {
    expect(quietHoursEnd(quietHours(), 'America/Denver', new Date('2026-10-11T05:00:00Z'))).toEqual(new Date('2026-10-11T13:00:00Z')); // 23:00
    expect(quietHoursEnd(quietHours(), 'America/Denver', new Date('2026-10-11T11:00:00Z'))).toEqual(new Date('2026-10-11T13:00:00Z')); // 05:00
    expect(quietHoursEnd(quietHours(), 'America/Denver', new Date('2026-10-11T13:00:00Z'))).toBeNull(); // 07:00 exactly
    expect(quietHoursEnd(quietHours(), 'America/Denver', new Date('2026-10-11T03:59:00Z'))).toBeNull(); // 21:59
  });

  it('handles same-day ranges, other zones, and off/degenerate settings', () => {
    const lunch = quietHours({ start: '12:00', end: '13:00' });
    expect(quietHoursEnd(lunch, 'America/New_York', new Date('2026-10-10T16:30:00Z'))).toEqual(new Date('2026-10-10T17:00:00Z'));
    expect(quietHoursEnd(lunch, 'America/New_York', new Date('2026-10-10T17:30:00Z'))).toBeNull();
    expect(quietHoursEnd({ ...lunch, enabled: false }, 'America/New_York', new Date('2026-10-10T16:30:00Z'))).toBeNull();
    expect(quietHoursEnd(quietHours({ start: '07:00', end: '07:00' }), 'America/Denver', NOON)).toBeNull();
    expect(quietHoursEnd(quietHours(), 'Not/AZone', NOON)).toBeNull();
  });

  it('follows daylight saving time', () => {
    // 2026-11-01 is the fall-back night in Denver: 07:00 MST is 14:00 UTC.
    expect(quietHoursEnd(quietHours(), 'America/Denver', new Date('2026-11-01T06:00:00Z'))).toEqual(new Date('2026-11-01T14:00:00Z'));
  });
});

describe('alert preference selection', () => {
  it('defaults every alert to on', () => {
    expect(isAlertEnabled(new Set(), 'job.step')).toBe(true);
    expect(enabledAlerts(new Set())).toEqual(PERSONAL_ALERTS.map((a) => a.type));
  });

  it('shows pilots and clients only the alerts that apply to them; admins see all', () => {
    const pilot = alertsForRole('pilot').map((a) => a.type);
    const client = alertsForRole('client').map((a) => a.type);
    expect(pilot).toContain('mission.posted');
    expect(pilot).not.toContain('job.deliverables_ready');
    expect(client).toContain('job.deliverables_ready');
    expect(client).not.toContain('payout.paid');
    expect(alertsForRole('admin')).toHaveLength(PERSONAL_ALERTS.length);
  });

  it('applies a menu selection to the shown alerts and keeps the rest', () => {
    const shown = alertsForRole('client');
    // payout.paid is not shown to clients, so its "off" setting is kept.
    expect(disabledAfterSelection(['payout.paid', 'job.step'], ['job.step', 'bogus'], shown)).toEqual([
      'job.status_changed',
      'job.deliverables_ready',
      'payout.paid',
      'dispute.updated',
    ]);
    expect(disabledAfterSelection([], shown.map((a) => a.type), shown)).toEqual([]);
  });

  it('round-trips a selection through the Save button id', () => {
    for (const disabled of [[], ['job.step'], PERSONAL_ALERTS.map((a) => a.type)] as string[][]) {
      expect(decodeDisabled(encodeDisabled(disabled))).toEqual(disabled);
    }
    expect(() => decodeDisabled('zz')).toThrow('no longer valid');
  });
});

describe('createEventDispatcher', () => {
  async function harness(userSettings: BotSettings = DEFAULT_BOT_SETTINGS, now = NOON) {
    const store = new ArgusStore(await openArgusDatabase({ path: ':memory:' }));
    await store.upsertLink({ discordUserId: USER, argusUserId: 'argus-1', displayName: 'Ava', role: 'pilot' });
    const dms: { userId: string; title?: string }[] = [];
    const posts: { channelId: string; title?: string }[] = [];
    const statuses: string[] = [];
    let dmOpen = true;
    let channelOk = true;
    let settingsCalls = 0;
    const dispatch = createEventDispatcher({
      store,
      settings: {
        get: async () => {
          settingsCalls++;
          return userSettings;
        },
      },
      routes,
      sendDm: async (userId: string, embed: EmbedBuilder) => {
        dms.push({ userId, title: embed.toJSON().title });
        return dmOpen;
      },
      postToChannel: async (channelId: string, embed: EmbedBuilder) => {
        posts.push({ channelId, title: embed.toJSON().title });
        return channelOk;
      },
      observeStatus: async (status) => statuses.push(status.state),
      now: () => now,
      todayIso: () => '2026-10-10',
      logger: silentLogger,
    });
    return {
      dispatch,
      store,
      dms,
      posts,
      statuses,
      settingsCalls: () => settingsCalls,
      closeDms: () => (dmOpen = false),
      breakChannel: () => (channelOk = false),
    };
  }

  it('DMs linked owners and posts broadcasts', async () => {
    const h = await harness();
    expect(await h.dispatch(sampleEvent('payout.paid', { userId: 'argus-1' }))).toEqual({ route: 'dm', delivered: true });
    expect(h.dms).toEqual([{ userId: USER, title: '💸 Payout sent: $265.00' }]);
    expect(await h.dispatch(sampleEvent('mission.posted'))).toEqual({ route: 'channel', delivered: true });
    expect(h.posts[0]).toEqual({ channelId: CHANNEL, title: '🛰️ New mission: Listing photos: 4-bed home' });
  });

  it('only asks Argus for settings when the event has a linked owner', async () => {
    const h = await harness();
    await h.dispatch(sampleEvent('mission.posted'));
    await h.dispatch(sampleEvent('payout.paid', { userId: 'someone-else' }));
    expect(h.settingsCalls()).toBe(0);
    await h.dispatch(sampleEvent('payout.paid', { userId: 'argus-1' }));
    expect(h.settingsCalls()).toBe(1);
  });

  it('hands status events to the monitor', async () => {
    const h = await harness();
    await h.dispatch(sampleEvent('service.status_changed', { state: 'outage' }));
    expect(h.statuses).toEqual(['outage']);
  });

  it('holds DMs in quiet hours and delivers them afterwards', async () => {
    const night = new Date('2026-10-11T05:00:00Z');
    const h = await harness(settings(quiet()), night);
    expect(await h.dispatch(sampleEvent('job.step', { userId: 'argus-1' }))).toEqual({
      route: 'dm',
      delivered: false,
      heldUntil: '2026-10-11T13:00:00.000Z',
      reason: 'quiet hours',
    });
    expect(h.dms).toEqual([]);

    const sent: string[] = [];
    const send = async (userId: string, embed: EmbedBuilder) => {
      sent.push(`${userId}:${embed.toJSON().title}`);
      return true;
    };
    expect(await deliverHeldDms(h.store, send, silentLogger, new Date('2026-10-11T12:59:00Z'))).toEqual({ sent: 0, dropped: 0 });
    expect(await deliverHeldDms(h.store, send, silentLogger, new Date('2026-10-11T13:00:00Z'))).toEqual({ sent: 1, dropped: 0 });
    expect(sent).toEqual([`${USER}:Job #1042: In flight`]);
    expect(await h.store.heldDmCount(USER)).toBe(0);
  });

  it('drops a held DM the user can no longer receive, and forgets held DMs on unlink', async () => {
    const night = new Date('2026-10-11T05:00:00Z');
    const h = await harness(settings(quiet()), night);
    await h.dispatch(sampleEvent('job.step', { userId: 'argus-1' }));
    expect(await deliverHeldDms(h.store, async () => false, silentLogger, new Date('2026-10-12T00:00:00Z'))).toEqual({
      sent: 0,
      dropped: 1,
    });
    await h.dispatch(sampleEvent('job.step', { userId: 'argus-1' }));
    await h.store.deleteLink(USER);
    expect(await h.store.heldDmCount(USER)).toBe(0);
  });

  it('reports closed DMs as undelivered without failing, but fails on a broken channel so Argus retries', async () => {
    const h = await harness();
    h.closeDms();
    expect(await h.dispatch(sampleEvent('payout.paid', { userId: 'argus-1' }))).toEqual({
      route: 'dm',
      delivered: false,
      reason: 'user has DMs closed',
    });
    h.breakChannel();
    await expect(h.dispatch(sampleEvent('mission.posted'))).rejects.toThrow('Could not post Argus event');
  });
});
