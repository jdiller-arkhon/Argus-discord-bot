import { silentLogger } from '@arkhon/shared';
import type { EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { openArgusDatabase } from '../src/db.js';
import { createEventDispatcher } from '../src/events/dispatch.js';
import { alertPreferencesFromSelection, enabledAlerts, isAlertEnabled, routeEvent } from '../src/events/routing.js';
import { sampleEvent } from '../src/events/samples.js';
import { alertsForRole, EVENT_TYPES, PERSONAL_ALERTS } from '../src/events/types.js';
import { ArgusStore } from '../src/store.js';
import { OTHER_USER, USER } from './fixtures.js';

const CHANNEL = '400000000000000001';
const routes = { 'mission.posted': CHANNEL };
const owner = (disabled: string[] = []) => ({ discordUserId: USER, disabledAlerts: new Set(disabled) });

describe('routeEvent', () => {
  it('sends service status changes to the status monitor, ignoring routes and owners', () => {
    expect(routeEvent(sampleEvent('service.status_changed'), { routes, owner: owner() })).toEqual({ kind: 'status' });
  });

  it('DMs the linked owner of a personal event', () => {
    for (const type of EVENT_TYPES.filter((t) => t !== 'service.status_changed')) {
      expect(routeEvent(sampleEvent(type, { userId: 'argus-1' }), { routes, owner: owner() })).toEqual({ kind: 'dm', discordUserId: USER });
    }
  });

  it('never posts a personal event to a channel, even when its type has a route', () => {
    const event = sampleEvent('mission.posted', { userId: 'argus-1' });
    expect(routeEvent(event, { routes })).toEqual({ kind: 'drop', reason: 'owner not linked' });
    expect(routeEvent(event, { routes, owner: owner(['mission.posted']) })).toEqual({
      kind: 'drop',
      reason: 'alert turned off by user',
    });
  });

  it('posts broadcast events to their configured channel', () => {
    expect(routeEvent(sampleEvent('mission.posted'), { routes })).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  it('drops broadcast events with no configured channel', () => {
    expect(routeEvent(sampleEvent('job.status_changed'), { routes })).toEqual({
      kind: 'drop',
      reason: 'no channel configured for job.status_changed',
    });
  });

  it('only mutes the alert type the user turned off', () => {
    const muted = owner(['payout.paid']);
    expect(routeEvent(sampleEvent('payout.paid', { userId: 'a' }), { routes, owner: muted }).kind).toBe('drop');
    expect(routeEvent(sampleEvent('payout.failed', { userId: 'a' }), { routes, owner: muted }).kind).toBe('dm');
  });
});

describe('alert preference filtering', () => {
  it('defaults every alert to on', () => {
    expect(isAlertEnabled(new Set(), 'job.step')).toBe(true);
    expect(enabledAlerts(new Set())).toEqual(PERSONAL_ALERTS.map((a) => a.type));
  });

  it('shows pilots and clients only the alerts that apply to them; admins see all', () => {
    const pilot = alertsForRole('pilot').map((a) => a.type);
    const client = alertsForRole('client').map((a) => a.type);
    expect(pilot).toContain('mission.posted');
    expect(pilot).toContain('credential.expiring');
    expect(pilot).not.toContain('job.deliverables_ready');
    expect(client).toContain('job.deliverables_ready');
    expect(client).not.toContain('payout.paid');
    expect(pilot).toContain('dispute.updated');
    expect(client).toContain('dispute.updated');
    expect(alertsForRole('admin')).toHaveLength(PERSONAL_ALERTS.length);
  });

  it('turns a menu selection into on/off for the shown alerts only', () => {
    const shown = alertsForRole('client');
    const prefs = alertPreferencesFromSelection(['job.step', 'payout.paid', 'not.a.type'], shown);
    expect(Object.keys(prefs).sort()).toEqual(shown.map((a) => a.type).sort());
    expect(prefs['job.step']).toBe(true);
    expect(prefs['job.status_changed']).toBe(false);
    // payout.paid was not shown to a client, so it is left alone.
    expect(prefs['payout.paid']).toBeUndefined();
  });

  it('round-trips through the store', () => {
    const store = new ArgusStore(openArgusDatabase(':memory:'));
    store.setAlertPreferences(USER, alertPreferencesFromSelection(['job.status_changed'], alertsForRole('client')));
    const disabled = store.disabledAlerts(USER);
    expect(enabledAlerts(disabled, alertsForRole('client'))).toEqual(['job.status_changed']);
    // Pilot-only alerts were never touched and stay on.
    expect(isAlertEnabled(disabled, 'payout.paid')).toBe(true);
    expect(store.disabledAlerts(OTHER_USER).size).toBe(0);
  });

  it('forgets preferences on unlink', () => {
    const store = new ArgusStore(openArgusDatabase(':memory:'));
    store.upsertLink({ discordUserId: USER, argusUserId: 'argus-1', displayName: 'Ava', role: 'client' });
    store.setAlertPreferences(USER, { 'job.step': false });
    store.deleteLink(USER);
    expect(store.disabledAlerts(USER).size).toBe(0);
  });
});

describe('createEventDispatcher', () => {
  function harness(disabled: Record<string, boolean> = {}) {
    const store = new ArgusStore(openArgusDatabase(':memory:'));
    store.upsertLink({ discordUserId: USER, argusUserId: 'argus-1', displayName: 'Ava', role: 'pilot' });
    store.setAlertPreferences(USER, disabled);
    const dms: { userId: string; title?: string }[] = [];
    const posts: { channelId: string; title?: string }[] = [];
    const statuses: string[] = [];
    let dmOpen = true;
    let channelOk = true;
    const dispatch = createEventDispatcher({
      store,
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
      todayIso: () => '2026-10-10',
      logger: silentLogger,
    });
    return {
      dispatch,
      dms,
      posts,
      statuses,
      closeDms: () => (dmOpen = false),
      breakChannel: () => (channelOk = false),
    };
  }

  it('DMs linked owners and posts broadcasts', async () => {
    const h = harness();
    expect(await h.dispatch(sampleEvent('payout.paid', { userId: 'argus-1' }))).toEqual({ route: 'dm', delivered: true });
    expect(h.dms).toEqual([{ userId: USER, title: '💸 Payout sent: $265.00' }]);
    expect(await h.dispatch(sampleEvent('mission.posted'))).toEqual({ route: 'channel', delivered: true });
    expect(h.posts[0]).toEqual({ channelId: CHANNEL, title: '🛰️ New mission: Listing photos: 4-bed home' });
  });

  it('hands status events to the monitor', async () => {
    const h = harness();
    await h.dispatch(sampleEvent('service.status_changed', { state: 'outage' }));
    expect(h.statuses).toEqual(['outage']);
  });

  it('respects muted alerts and unknown owners', async () => {
    const h = harness({ 'payout.paid': false });
    expect((await h.dispatch(sampleEvent('payout.paid', { userId: 'argus-1' }))).route).toBe('drop');
    expect((await h.dispatch(sampleEvent('payout.failed', { userId: 'someone-else' }))).route).toBe('drop');
    expect(h.dms).toEqual([]);
  });

  it('reports closed DMs as undelivered without failing, but fails on a broken channel so Argus retries', async () => {
    const h = harness();
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
