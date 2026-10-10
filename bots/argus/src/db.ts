import { type Db, jobRunsMigrationSql, type Migration, openDatabase, ticketsMigrationSql } from '@arkhon/shared';

/**
 * The bot stores Discord/Argus identifiers, display names, roles, processed
 * webhook IDs, DMs held for quiet hours, and the last announced service status.
 * Alert preferences live on Argus.
 * Never add addresses, payment details, or certificate numbers here.
 */
export const argusMigrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE links (
        discord_user_id TEXT PRIMARY KEY,
        argus_user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        linked_at TEXT NOT NULL
      );

      -- Only opt-outs are stored: a personal alert type is on unless a row
      -- here says otherwise, so new event types default to on.
      CREATE TABLE alert_prefs (
        discord_user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (discord_user_id, event_type)
      );

      -- Webhook event IDs already handled, so Argus retries are not delivered twice.
      CREATE TABLE processed_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      -- Single row: what #argus-status last announced, plus a pending state
      -- that must be seen on consecutive polls before it is announced.
      CREATE TABLE status_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        announced_state TEXT,
        pending_state TEXT,
        pending_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      ${ticketsMigrationSql}

      ${jobRunsMigrationSql}

      -- Tables below back MockArgusClient only (ARGUS_CLIENT=mock).
      CREATE TABLE mock_users (
        argus_user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        standing_tier TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE mock_redeemed_codes (
        code TEXT PRIMARY KEY,
        argus_user_id TEXT NOT NULL REFERENCES mock_users(argus_user_id),
        discord_user_id TEXT NOT NULL,
        redeemed_at TEXT NOT NULL
      );

      CREATE TABLE mock_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_user_id TEXT NOT NULL,
        client_name TEXT NOT NULL,
        pilot_user_id TEXT,
        pilot_name TEXT,
        title TEXT NOT NULL,
        service_type TEXT NOT NULL,
        locality TEXT NOT NULL,
        status TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        scheduled_for TEXT,
        time_window TEXT,
        amount_cents INTEGER NOT NULL,
        payout_cents INTEGER NOT NULL,
        image_count INTEGER NOT NULL,
        add_ons TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      CREATE INDEX mock_jobs_client ON mock_jobs (client_user_id);
      CREATE INDEX mock_jobs_pilot ON mock_jobs (pilot_user_id);

      CREATE TABLE mock_job_steps (
        job_id INTEGER NOT NULL REFERENCES mock_jobs(id),
        step TEXT NOT NULL,
        at TEXT NOT NULL,
        PRIMARY KEY (job_id, step)
      );

      CREATE TABLE mock_deliverables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES mock_jobs(id),
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        image_count INTEGER NOT NULL
      );

      CREATE TABLE mock_missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        service_type TEXT NOT NULL,
        locality TEXT NOT NULL,
        distance_mi REAL,
        payout_cents INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        scheduled_for TEXT,
        time_window TEXT,
        image_count INTEGER NOT NULL,
        add_ons TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        pilot_user_id TEXT,
        job_id INTEGER,
        posted_at TEXT NOT NULL
      );

      CREATE TABLE mock_payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pilot_user_id TEXT NOT NULL,
        mission_title TEXT,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        date TEXT NOT NULL
      );

      CREATE TABLE mock_credentials (
        pilot_user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT,
        insurance_mode TEXT,
        PRIMARY KEY (pilot_user_id, kind)
      );

      CREATE TABLE mock_service_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        summary TEXT,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'settings-on-argus-and-held-dms',
    sql: `
      -- Alert preferences moved to Argus (discord_bot_settings), edited in the
      -- pilot portal and with /argus alerts, so the bot no longer keeps a copy.
      DROP TABLE alert_prefs;

      -- DMs held during the recipient's quiet hours, sent once deliver_at passes.
      CREATE TABLE held_dms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discord_user_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        embed_json TEXT NOT NULL,
        deliver_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX held_dms_deliver_at ON held_dms (deliver_at);

      -- Backs MockArgusClient.getBotSettings / updateBotSettings.
      CREATE TABLE mock_bot_settings (
        argus_user_id TEXT PRIMARY KEY,
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function openArgusDatabase(path: string): Db {
  return openDatabase(path, argusMigrations);
}
