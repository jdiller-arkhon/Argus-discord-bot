import { type SqlDb, stmt } from '@arkhon/shared';
import type { ArgusRole, ServiceState } from './argus/types.js';
import type { StatusMemory } from './status/monitor.js';

export interface HeldDm {
  id: number;
  discordUserId: string;
  eventId: string;
  /** Embed JSON as produced by EmbedBuilder.toJSON(). */
  embed: unknown;
  deliverAt: string;
}

export interface Link {
  discordUserId: string;
  argusUserId: string;
  displayName: string;
  role: ArgusRole;
  linkedAt: string;
}

interface LinkRow {
  discord_user_id: string;
  argus_user_id: string;
  display_name: string;
  role: ArgusRole;
  linked_at: string;
}

const toLink = (row: LinkRow): Link => ({
  discordUserId: row.discord_user_id,
  argusUserId: row.argus_user_id,
  displayName: row.display_name,
  role: row.role,
  linkedAt: row.linked_at,
});

/** Data access for the bot's own tables. */
export class ArgusStore {
  constructor(readonly db: SqlDb) {}

  async getLink(discordUserId: string): Promise<Link | undefined> {
    const row = await this.db.get<LinkRow>('SELECT * FROM links WHERE discord_user_id = ?', discordUserId);
    return row ? toLink(row) : undefined;
  }

  async getLinkByArgusId(argusUserId: string): Promise<Link | undefined> {
    const row = await this.db.get<LinkRow>('SELECT * FROM links WHERE argus_user_id = ?', argusUserId);
    return row ? toLink(row) : undefined;
  }

  /**
   * Stores the mapping. An Argus account can be linked to only one Discord
   * account, so any previous link for either side is replaced, together with
   * the DMs held for the Discord account it is taken from.
   */
  async upsertLink(link: Omit<Link, 'linkedAt'>, now: Date = new Date()): Promise<void> {
    await this.db.batch([
      stmt(
        `DELETE FROM held_dms WHERE discord_user_id IN
           (SELECT discord_user_id FROM links WHERE argus_user_id = ? AND discord_user_id != ?)`,
        link.argusUserId,
        link.discordUserId,
      ),
      stmt('DELETE FROM links WHERE argus_user_id = ? AND discord_user_id != ?', link.argusUserId, link.discordUserId),
      stmt(
        `INSERT INTO links (discord_user_id, argus_user_id, display_name, role, linked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (discord_user_id) DO UPDATE SET
           argus_user_id = excluded.argus_user_id,
           display_name = excluded.display_name,
           role = excluded.role,
           linked_at = excluded.linked_at`,
        link.discordUserId,
        link.argusUserId,
        link.displayName,
        link.role,
        now.toISOString(),
      ),
    ]);
  }

  /** Removes the link and any DMs held for the user. */
  async deleteLink(discordUserId: string): Promise<boolean> {
    const [removed] = await this.db.batch([
      stmt('DELETE FROM links WHERE discord_user_id = ?', discordUserId),
      stmt('DELETE FROM held_dms WHERE discord_user_id = ?', discordUserId),
    ]);
    return (removed?.changes ?? 0) > 0;
  }

  /** Holds a DM until the user's quiet hours end. */
  async holdDm(
    dm: { discordUserId: string; eventId: string; embed: unknown; deliverAt: Date },
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.run(
      'INSERT INTO held_dms (discord_user_id, event_id, embed_json, deliver_at, created_at) VALUES (?, ?, ?, ?, ?)',
      dm.discordUserId,
      dm.eventId,
      JSON.stringify(dm.embed),
      dm.deliverAt.toISOString(),
      now.toISOString(),
    );
  }

  /** Held DMs whose time has come, oldest first. */
  async dueHeldDms(now: Date = new Date(), limit = 50): Promise<HeldDm[]> {
    const rows = await this.db.all<{
      id: number;
      discord_user_id: string;
      event_id: string;
      embed_json: string;
      deliver_at: string;
    }>('SELECT * FROM held_dms WHERE deliver_at <= ? ORDER BY deliver_at, id LIMIT ?', now.toISOString(), limit);
    return rows.map((row) => ({
      id: row.id,
      discordUserId: row.discord_user_id,
      eventId: row.event_id,
      embed: JSON.parse(row.embed_json) as unknown,
      deliverAt: row.deliver_at,
    }));
  }

  async deleteHeldDm(id: number): Promise<void> {
    await this.db.run('DELETE FROM held_dms WHERE id = ?', id);
  }

  async heldDmCount(discordUserId: string): Promise<number> {
    const row = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM held_dms WHERE discord_user_id = ?', discordUserId);
    return row?.n ?? 0;
  }

  /** Records a webhook event ID; resolves false if it was already processed. */
  async claimEvent(eventId: string, eventType: string, now: Date = new Date()): Promise<boolean> {
    const result = await this.db.run(
      'INSERT OR IGNORE INTO processed_events (event_id, event_type, received_at) VALUES (?, ?, ?)',
      eventId,
      eventType,
      now.toISOString(),
    );
    return result.changes === 1;
  }

  /** Forgets an event ID after a failed delivery so Argus's retry is processed. */
  async releaseEvent(eventId: string): Promise<void> {
    await this.db.run('DELETE FROM processed_events WHERE event_id = ?', eventId);
  }

  async pruneProcessedEvents(days: number, now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return (await this.db.run('DELETE FROM processed_events WHERE received_at < ?', cutoff)).changes;
  }

  async getStatusMemory(): Promise<StatusMemory> {
    const row = await this.db.get<{
      announced_state: ServiceState | null;
      pending_state: ServiceState | null;
      pending_count: number;
    }>('SELECT announced_state, pending_state, pending_count FROM status_state WHERE id = 1');
    return {
      announced: row?.announced_state ?? null,
      pending: row?.pending_state ?? null,
      pendingCount: row?.pending_count ?? 0,
    };
  }

  async saveStatusMemory(memory: StatusMemory, now: Date = new Date()): Promise<void> {
    await this.db.run(
      `INSERT INTO status_state (id, announced_state, pending_state, pending_count, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET announced_state = excluded.announced_state, pending_state = excluded.pending_state,
         pending_count = excluded.pending_count, updated_at = excluded.updated_at`,
      memory.announced,
      memory.pending,
      memory.pendingCount,
      now.toISOString(),
    );
  }
}
