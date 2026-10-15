import type { SqlDb } from '../sql.js';
import { isTicketStatus, type TicketStatus } from './state.js';

/** Include in a bot's migrations to enable {@link TicketStore}. */
export const ticketsMigrationSql = `
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  product TEXT NOT NULL,
  user_id TEXT NOT NULL,
  channel_id TEXT UNIQUE,
  channel_kind TEXT NOT NULL DEFAULT 'thread',
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  claimed_by_id TEXT,
  closed_by_id TEXT,
  created_at TEXT NOT NULL,
  first_staff_reply_at TEXT,
  closed_at TEXT
);
CREATE INDEX tickets_user_product_status ON tickets (user_id, product, status);
`;

export interface Ticket {
  id: number;
  guildId: string;
  product: string;
  userId: string;
  channelId: string | null;
  channelKind: 'thread' | 'channel';
  subject: string;
  description: string;
  /** Optional product reference the user supplied, e.g. an Argus job ID. */
  reference: string | null;
  status: TicketStatus;
  claimedById: string | null;
  closedById: string | null;
  createdAt: string;
  firstStaffReplyAt: string | null;
  closedAt: string | null;
}

interface TicketRow {
  id: number;
  guild_id: string;
  product: string;
  user_id: string;
  channel_id: string | null;
  channel_kind: string;
  subject: string;
  description: string;
  reference: string | null;
  status: string;
  claimed_by_id: string | null;
  closed_by_id: string | null;
  created_at: string;
  first_staff_reply_at: string | null;
  closed_at: string | null;
}

function toTicket(row: TicketRow): Ticket {
  if (!isTicketStatus(row.status)) throw new Error(`Ticket ${row.id} has bad status ${row.status}`);
  return {
    id: row.id,
    guildId: row.guild_id,
    product: row.product,
    userId: row.user_id,
    channelId: row.channel_id,
    channelKind: row.channel_kind === 'channel' ? 'channel' : 'thread',
    subject: row.subject,
    description: row.description,
    reference: row.reference,
    status: row.status,
    claimedById: row.claimed_by_id,
    closedById: row.closed_by_id,
    createdAt: row.created_at,
    firstStaffReplyAt: row.first_staff_reply_at,
    closedAt: row.closed_at,
  };
}

export interface NewTicket {
  guildId: string;
  product: string;
  userId: string;
  subject: string;
  description: string;
  reference?: string | null;
}

/**
 * Storage for support tickets. Status changes are optimistic (`WHERE status = from`) so two staff
 * clicking at once cannot both win.
 */
export class TicketStore {
  constructor(readonly db: SqlDb) {}

  async create(ticket: NewTicket, now: Date = new Date()): Promise<Ticket> {
    const result = await this.db.run(
      `INSERT INTO tickets (guild_id, product, user_id, subject, description, reference, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ticket.guildId,
      ticket.product,
      ticket.userId,
      ticket.subject,
      ticket.description,
      ticket.reference ?? null,
      now.toISOString(),
    );
    const created = result.lastRowId === null ? undefined : await this.get(result.lastRowId);
    if (!created) throw new Error('Ticket was not created');
    return created;
  }

  async get(id: number): Promise<Ticket | undefined> {
    const row = await this.db.get<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
    return row ? toTicket(row) : undefined;
  }

  async getByChannel(channelId: string): Promise<Ticket | undefined> {
    const row = await this.db.get<TicketRow>('SELECT * FROM tickets WHERE channel_id = ?', channelId);
    return row ? toTicket(row) : undefined;
  }

  /** The user's ticket for `product` that is still open or waiting, if any. */
  async findActiveForUser(userId: string, product: string): Promise<Ticket | undefined> {
    const row = await this.db.get<TicketRow>(
      `SELECT * FROM tickets
       WHERE user_id = ? AND product = ? AND status IN ('open', 'waiting') AND channel_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`,
      userId,
      product,
    );
    return row ? toTicket(row) : undefined;
  }

  async activeChannelIds(): Promise<string[]> {
    const rows = await this.db.all<{ channel_id: string }>(
      `SELECT channel_id FROM tickets WHERE status IN ('open', 'waiting') AND channel_id IS NOT NULL`,
    );
    return rows.map((row) => row.channel_id);
  }

  async setChannel(id: number, channelId: string, kind: 'thread' | 'channel'): Promise<void> {
    await this.db.run('UPDATE tickets SET channel_id = ?, channel_kind = ? WHERE id = ?', channelId, kind, id);
  }

  /** Removes a ticket whose channel could not be created. */
  async delete(id: number): Promise<void> {
    await this.db.run('DELETE FROM tickets WHERE id = ?', id);
  }

  /** Moves `from` -> `to`; returns false if the ticket changed in the meantime. */
  async transition(id: number, from: TicketStatus, to: TicketStatus, claimedById?: string): Promise<boolean> {
    const result =
      claimedById === undefined
        ? await this.db.run('UPDATE tickets SET status = ? WHERE id = ? AND status = ?', to, id, from)
        : await this.db.run(
            'UPDATE tickets SET status = ?, claimed_by_id = ? WHERE id = ? AND status = ?',
            to,
            claimedById,
            id,
            from,
          );
    return result.changes > 0;
  }

  /** Closes an open or waiting ticket; returns false if it was already closed. */
  async close(id: number, closedById: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.db.run(
      `UPDATE tickets SET status = 'closed', closed_by_id = ?, closed_at = ?
       WHERE id = ? AND status IN ('open', 'waiting')`,
      closedById,
      now.toISOString(),
      id,
    );
    return result.changes > 0;
  }

  async recordFirstStaffReply(id: number, at: Date): Promise<void> {
    await this.db.run(
      'UPDATE tickets SET first_staff_reply_at = ? WHERE id = ? AND first_staff_reply_at IS NULL',
      at.toISOString(),
      id,
    );
  }
}
