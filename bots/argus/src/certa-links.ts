import type { Logger } from '@arkhon/shared';
import Database from 'better-sqlite3';

/** Answers "is this Discord user also linked to Certa?" */
export interface CertaLinkLookup {
  /** The user's Certa display name, or null when not linked or unknown. */
  displayName(discordUserId: string): string | null;
  close(): void;
}

export const noCertaLinks: CertaLinkLookup = { displayName: () => null, close: () => {} };

/**
 * Reads the Certa bot's `links` table from its SQLite file, read-only. The
 * file is opened per lookup so a Certa bot restart or migration never leaves
 * this bot holding a stale handle, and any failure counts as "not linked".
 */
export function createCertaLinkLookup(path: string | undefined, logger: Logger): CertaLinkLookup {
  if (!path) return noCertaLinks;
  return {
    displayName(discordUserId) {
      let db: Database.Database | undefined;
      try {
        db = new Database(path, { readonly: true, fileMustExist: true });
        const row = db.prepare('SELECT display_name FROM links WHERE discord_user_id = ?').get(discordUserId) as
          | { display_name: string }
          | undefined;
        return row?.display_name ?? null;
      } catch (error) {
        logger.warn('Could not read Certa links', { error });
        return null;
      } finally {
        db?.close();
      }
    },
    close() {},
  };
}
