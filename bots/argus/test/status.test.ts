import { silentLogger } from '@arkhon/shared';
import { describe, expect, it } from 'vitest';
import type { ServiceState, ServiceStatus } from '../src/argus/types.js';
import { openArgusDatabase } from '../src/db.js';
import { announcementContent } from '../src/status/announce.js';
import { evaluateStatus, type StatusAnnouncement, StatusMonitor } from '../src/status/monitor.js';
import { ArgusStore } from '../src/store.js';

const status = (state: ServiceState): ServiceStatus => ({ state, summary: null, components: [], updatedAt: '2026-10-10T12:00:00Z' });

describe('evaluateStatus', () => {
  it('records the first observation silently', () => {
    const result = evaluateStatus({ announced: null, pending: null, pendingCount: 0 }, 'degraded', 2);
    expect(result).toEqual({ memory: { announced: 'degraded', pending: null, pendingCount: 0 }, announce: null });
  });

  it('needs the configured number of consecutive polls before announcing', () => {
    let memory = { announced: 'operational' as ServiceState | null, pending: null as ServiceState | null, pendingCount: 0 };
    let result = evaluateStatus(memory, 'outage', 2);
    expect(result.announce).toBeNull();
    memory = result.memory;
    result = evaluateStatus(memory, 'outage', 2);
    expect(result.announce).toEqual({ from: 'operational', to: 'outage', ping: true });
    expect(result.memory).toEqual({ announced: 'outage', pending: null, pendingCount: 0 });
  });

  it('forgets a blip when the old state comes back', () => {
    const blip = evaluateStatus({ announced: 'operational', pending: null, pendingCount: 0 }, 'outage', 3).memory;
    expect(evaluateStatus(blip, 'operational', 3)).toEqual({
      memory: { announced: 'operational', pending: null, pendingCount: 0 },
      announce: null,
    });
  });

  it('restarts the count when the pending state changes', () => {
    const one = evaluateStatus({ announced: 'operational', pending: null, pendingCount: 0 }, 'degraded', 2).memory;
    const two = evaluateStatus(one, 'outage', 2);
    expect(two.announce).toBeNull();
    expect(two.memory).toEqual({ announced: 'operational', pending: 'outage', pendingCount: 1 });
  });

  it('pings only for degraded and outage', () => {
    const announce = (from: ServiceState, to: ServiceState) =>
      evaluateStatus({ announced: from, pending: null, pendingCount: 0 }, to, 1).announce;
    expect(announce('operational', 'degraded')?.ping).toBe(true);
    expect(announce('degraded', 'outage')?.ping).toBe(true);
    expect(announce('outage', 'operational')?.ping).toBe(false);
    expect(announce('operational', 'maintenance')?.ping).toBe(false);
    expect(announce('outage', 'degraded')?.ping).toBe(true);
  });
});

describe('announcementContent', () => {
  const role = '500000000000000001';
  it('mentions the role only when the announcement pings and a role is configured', () => {
    expect(announcementContent({ from: 'operational', to: 'outage', ping: true }, role)).toBe(
      `<@&${role}> Argus is reporting **service outage**.`,
    );
    expect(announcementContent({ from: 'outage', to: 'operational', ping: false }, role)).toBeUndefined();
    expect(announcementContent({ from: 'operational', to: 'degraded', ping: true }, undefined)).toBeUndefined();
  });
});

describe('StatusMonitor', () => {
  async function monitor(confirmations = 2) {
    const store = new ArgusStore(await openArgusDatabase({ path: ':memory:' }));
    const announced: StatusAnnouncement[] = [];
    let failPost = false;
    const m = new StatusMonitor({
      load: () => store.getStatusMemory(),
      save: (memory) => store.saveStatusMemory(memory),
      pollConfirmations: confirmations,
      logger: silentLogger,
      announce: async (announcement) => {
        if (failPost) throw new Error('discord down');
        announced.push(announcement);
      },
    });
    return { m, store, announced, failPosts: (fail: boolean) => (failPost = fail) };
  }

  it('debounces polls but applies webhook updates immediately, persisting state', async () => {
    const { m, store, announced } = await monitor();
    await m.observe(status('operational'), 'poll');
    expect(await m.observe(status('degraded'), 'poll')).toBeNull();
    expect(await m.observe(status('degraded'), 'poll')).toEqual({ from: 'operational', to: 'degraded', ping: true });
    expect(await m.observe(status('operational'), 'webhook')).toEqual({ from: 'degraded', to: 'operational', ping: false });
    expect(announced).toHaveLength(2);
    expect(await store.getStatusMemory()).toEqual({ announced: 'operational', pending: null, pendingCount: 0 });
  });

  it('retries the announcement on the next observation when posting fails', async () => {
    const { m, announced, failPosts } = await monitor(1);
    await m.observe(status('operational'), 'poll');
    failPosts(true);
    await expect(m.observe(status('outage'), 'poll')).rejects.toThrow('discord down');
    failPosts(false);
    expect(await m.observe(status('outage'), 'poll')).toEqual({ from: 'operational', to: 'outage', ping: true });
    expect(announced).toHaveLength(1);
  });

  it('serializes concurrent observations', async () => {
    const { m, announced } = await monitor(1);
    await m.observe(status('operational'), 'poll');
    await Promise.all([m.observe(status('outage'), 'webhook'), m.observe(status('outage'), 'poll')]);
    expect(announced).toEqual([{ from: 'operational', to: 'outage', ping: true }]);
  });
});
