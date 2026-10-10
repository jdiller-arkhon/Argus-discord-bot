import type { Db } from '@arkhon/shared';
import type { ArgusRole, ServiceState } from './argus/types.js';
import type { StatusMemory } from './status/monitor.js';

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
  constructor(readonly db: Db) {}

  getLink(discordUserId: string): Link | undefined {
    const row = this.db.prepare('SELECT * FROM links WHERE discord_user_id = ?').get(discordUserId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  getLinkByArgusId(argusUserId: string): Link | undefined {
    const row = this.db.prepare('SELECT * FROM links WHERE argus_user_id = ?').get(argusUserId) as LinkRow | undefined;
    return row ? toLink(row) : undefined;
  }

  /**
   * Stores the mapping. An Argus account can be linked to only one Discord
   * account, so any previous link for either side is replaced.
   */
  upsertLink(link: Omit<Link, 'linkedAt'>, now: Date = new Date()): void {
    this.db.transaction(() => {
      const previous = this.db
        .prepare('SELECT discord_user_id FROM links WHERE argus_user_id = ? AND discord_user_id != ?')
        .all(link.argusUserId, link.discordUserId) as { discord_user_id: string }[];
      for (const row of previous) this.deleteLinkData(row.discord_user_id);
      this.db
        .prepare(
          `INSERT INTO links (discord_user_id, argus_user_id, display_name, role, linked_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (discord_user_id) DO UPDATE SET
             argus_user_id = excluded.argus_user_id,
             display_name = excluded.display_name,
             role = excluded.role,
             linked_at = excluded.linked_at`,
        )
        .run(link.discordUserId, link.argusUserId, link.displayName, link.role, now.toISOString());
    })();
  }

  /** Removes the link and the user's alert preferences. */
  deleteLink(discordUserId: string): boolean {
    return this.db.transaction(() => this.deleteLinkData(discordUserId))();
  }

  private deleteLinkData(discordUserId: string): boolean {
    const removed = this.db.prepare('DELETE FROM links WHERE discord_user_id = ?').run(discordUserId).changes > 0;
    this.db.prepare('DELETE FROM alert_prefs WHERE discord_user_id = ?').run(discordUserId);
    return removed;
  }

  /** Alert types the user turned off. */
  disabledAlerts(discordUserId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT event_type FROM alert_prefs WHERE discord_user_id = ? AND enabled = 0')
      .all(discordUserId) as { event_type: string }[];
    return new Set(rows.map((row) => row.event_type));
  }

  setAlertPreferences(discordUserId: string, preferences: Record<string, boolean>, now: Date = new Date()): void {
    const upsert = this.db.prepare(
      `INSERT INTO alert_prefs (discord_user_id, event_type, enabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (discord_user_id, event_type) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const [type, enabled] of Object.entries(preferences)) {
        upsert.run(discordUserId, type, enabled ? 1 : 0, now.toISOString());
      }
    })();
  }

  /** Records a webhook event ID; returns false if it was already processed. */
  claimEvent(eventId: string, eventType: string, now: Date = new Date()): boolean {
    return (
      this.db
        .prepare('INSERT OR IGNORE INTO processed_events (event_id, event_type, received_at) VALUES (?, ?, ?)')
        .run(eventId, eventType, now.toISOString()).changes === 1
    );
  }

  /** Forgets an event ID after a failed delivery so Argus's retry is processed. */
  releaseEvent(eventId: string): void {
    this.db.prepare('DELETE FROM processed_events WHERE event_id = ?').run(eventId);
  }

  pruneProcessedEvents(days: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM processed_events WHERE received_at < ?').run(cutoff).changes;
  }

  getStatusMemory(): StatusMemory {
    const row = this.db.prepare('SELECT announced_state, pending_state, pending_count FROM status_state WHERE id = 1').get() as
      | { announced_state: ServiceState | null; pending_state: ServiceState | null; pending_count: number }
      | undefined;
    return {
      announced: row?.announced_state ?? null,
      pending: row?.pending_state ?? null,
      pendingCount: row?.pending_count ?? 0,
    };
  }

  saveStatusMemory(memory: StatusMemory, now: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO status_state (id, announced_state, pending_state, pending_count, updated_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET announced_state = excluded.announced_state, pending_state = excluded.pending_state,
           pending_count = excluded.pending_count, updated_at = excluded.updated_at`,
      )
      .run(memory.announced, memory.pending, memory.pendingCount, now.toISOString());
  }
}
