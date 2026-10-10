import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { ticketChannelName } from '../src/tickets/flow.js';
import { canTransition, InvalidTransitionError, nextStatus, TICKET_ACTIONS, TICKET_STATUSES } from '../src/tickets/state.js';
import { TicketStore, ticketsMigrationSql } from '../src/tickets/store.js';

describe('ticket state machine', () => {
  it('follows the documented transitions', () => {
    expect(nextStatus('open', 'claim')).toBe('open');
    expect(nextStatus('open', 'markWaiting')).toBe('waiting');
    expect(nextStatus('waiting', 'userReply')).toBe('open');
    expect(nextStatus('waiting', 'claim')).toBe('waiting');
    expect(nextStatus('open', 'close')).toBe('closed');
    expect(nextStatus('waiting', 'close')).toBe('closed');
  });

  it('treats closed as terminal', () => {
    for (const action of TICKET_ACTIONS) expect(canTransition('closed', action)).toBe(false);
    expect(() => nextStatus('closed', 'close')).toThrow('This ticket is already closed.');
  });

  it('rejects waiting twice with a readable message', () => {
    expect(() => nextStatus('waiting', 'markWaiting')).toThrow(InvalidTransitionError);
    expect(() => nextStatus('waiting', 'markWaiting')).toThrow('already waiting on the user');
  });

  it('defines every status', () => {
    expect([...TICKET_STATUSES]).toEqual(['open', 'waiting', 'closed']);
  });
});

describe('TicketStore', () => {
  const setup = () => new TicketStore(openDatabase(':memory:', [{ version: 1, name: 'tickets', sql: ticketsMigrationSql }]));
  const base = { guildId: '1'.repeat(18), product: 'argus', userId: '2'.repeat(18), subject: 'Upload stuck', description: 'Zip upload stalls at 90%' };

  it('creates tickets and finds the active one per user and product', () => {
    const store = setup();
    const ticket = store.create({ ...base, reference: '1042' });
    expect(ticket).toMatchObject({ status: 'open', reference: '1042', channelId: null });
    // Not "active" until it has a channel.
    expect(store.findActiveForUser(base.userId, 'argus')).toBeUndefined();
    store.setChannel(ticket.id, '3'.repeat(18), 'thread');
    expect(store.findActiveForUser(base.userId, 'argus')?.id).toBe(ticket.id);
    expect(store.findActiveForUser(base.userId, 'certa')).toBeUndefined();
    expect(store.activeChannelIds()).toEqual(['3'.repeat(18)]);
  });

  it('applies optimistic transitions and closes once', () => {
    const store = setup();
    const ticket = store.create(base);
    store.setChannel(ticket.id, '3'.repeat(18), 'channel');
    expect(store.transition(ticket.id, 'open', 'open', '9'.repeat(18))).toBe(true);
    expect(store.get(ticket.id)?.claimedById).toBe('9'.repeat(18));
    expect(store.transition(ticket.id, 'open', 'waiting')).toBe(true);
    // A second click based on the stale "open" state loses.
    expect(store.transition(ticket.id, 'open', 'waiting')).toBe(false);
    expect(store.close(ticket.id, '9'.repeat(18), new Date('2026-10-10T00:00:00Z'))).toBe(true);
    expect(store.close(ticket.id, '9'.repeat(18))).toBe(false);
    expect(store.get(ticket.id)).toMatchObject({ status: 'closed', closedAt: '2026-10-10T00:00:00.000Z' });
    expect(store.activeChannelIds()).toEqual([]);
  });

  it('records only the first staff reply', () => {
    const store = setup();
    const ticket = store.create(base);
    store.recordFirstStaffReply(ticket.id, new Date('2026-10-10T01:00:00Z'));
    store.recordFirstStaffReply(ticket.id, new Date('2026-10-10T02:00:00Z'));
    expect(store.get(ticket.id)?.firstStaffReplyAt).toBe('2026-10-10T01:00:00.000Z');
  });
});

describe('ticketChannelName', () => {
  it('slugs the username and pads the id', () => {
    expect(ticketChannelName(7, 'argus', 'Ava.Rodriguez!!')).toBe('argus-0007-ava-rodriguez');
    expect(ticketChannelName(12345, 'argus', '___')).toBe('argus-12345-user');
  });
});
