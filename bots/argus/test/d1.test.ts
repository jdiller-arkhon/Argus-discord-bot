import { describe, expect, it } from 'vitest';
import { bridged } from '../../../packages/shared/test/d1-fake.js';
import { MockArgusClient } from '../src/argus/mock-client.js';
import { argusMigrations } from '../src/db.js';
import { ArgusStore } from '../src/store.js';
import { migrate } from '@arkhon/shared';
import { NOW, USER } from './fixtures.js';

// The bot on Cloudflare: every migration and query goes through the D1 bridge.
describe('Argus on D1', () => {
  it('applies every migration and serves the store and mock client', async () => {
    const { db } = bridged();
    expect(await migrate(db, argusMigrations)).toEqual(argusMigrations.map((m) => m.version));

    const store = new ArgusStore(db);
    await store.upsertLink({ discordUserId: USER, argusUserId: 'argus-1', displayName: 'Ava', role: 'pilot' });
    expect(await store.getLink(USER)).toMatchObject({ argusUserId: 'argus-1', role: 'pilot' });
    expect(await store.claimEvent('evt_1', 'payout.paid')).toBe(true);
    expect(await store.claimEvent('evt_1', 'payout.paid')).toBe(false);

    const mock = new MockArgusClient(db, { timezone: 'America/Denver', now: () => NOW });
    const linked = await mock.redeemLinkCode('PILOT-1', USER);
    expect(linked.role).toBe('pilot');
    expect((await mock.listJobs(linked.argusUserId, 'active')).length).toBeGreaterThan(0);
    const board = await mock.listOpenMissions(linked.argusUserId);
    const accepted = await mock.acceptMission(linked.argusUserId, board.missions[0]!.id);
    expect(accepted.jobId).toBeGreaterThan(0);
  });
});
