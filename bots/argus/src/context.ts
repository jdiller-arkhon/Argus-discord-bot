import { type Logger, type TicketFlow, UserFacingError } from '@arkhon/shared';
import type { DateTime } from 'luxon';
import {
  type ArgusClient,
  ArgusAuthError,
  ArgusInvalidLinkCodeError,
  ArgusNotFoundError,
  ArgusRejectedError,
  ArgusResponseError,
  ArgusUnavailableError,
  ArgusUserNotFoundError,
} from './argus/index.js';
import type { CertaLinkLookup } from './certa-links.js';
import type { ArgusConfig } from './config.js';
import type { Faq } from './faq.js';
import type { ArgusStore, Link } from './store.js';

export interface ArgusContext {
  config: ArgusConfig;
  store: ArgusStore;
  argus: ArgusClient;
  faq: Faq;
  certaLinks: CertaLinkLookup;
  /** Null when ARGUS_SUPPORT_CHANNEL_ID / ARGUS_STAFF_ROLE_ID are not set. */
  tickets: TicketFlow | null;
  logger: Logger;
  /** Current time in the bot's configured time zone. */
  now: () => DateTime;
}

export const NOT_LINKED_MESSAGE =
  "Your Discord account isn't linked to Argus yet. In Argus, open **Settings → Discord** to get a one-time code, " +
  'then run `/argus link code:<code>`.';

export const PILOT_ONLY_MESSAGE =
  'That command is for Argus pilots. Your linked account is a client account; try `/argus jobs` instead.';

/** Returns the caller's link or throws a friendly "not linked" error. */
export function requireLink(context: ArgusContext, discordUserId: string): Link {
  const link = context.store.getLink(discordUserId);
  if (!link) throw new UserFacingError(NOT_LINKED_MESSAGE);
  return link;
}

/** Like {@link requireLink}, but only for pilot accounts. */
export function requirePilot(context: ArgusContext, discordUserId: string): Link {
  const link = requireLink(context, discordUserId);
  if (link.role !== 'pilot') throw new UserFacingError(PILOT_ONLY_MESSAGE);
  return link;
}

/**
 * Runs an Argus API call and converts its typed errors into messages the user
 * can act on. Unexpected failures are logged and rethrown as-is.
 */
export async function callArgus<T>(context: ArgusContext, action: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ArgusInvalidLinkCodeError) {
      throw new UserFacingError(
        "That link code isn't valid. Codes are single-use and expire; generate a new one in Argus and try again.",
      );
    }
    if (error instanceof ArgusUserNotFoundError) {
      throw new UserFacingError('Your linked Argus account could not be found. Run `/argus unlink`, then link again with a new code.');
    }
    if (error instanceof ArgusNotFoundError) {
      throw new UserFacingError("Argus couldn't find that, or it isn't on your account.");
    }
    if (error instanceof ArgusRejectedError) {
      throw new UserFacingError(error.detail ?? 'Argus declined that request.');
    }
    if (error instanceof ArgusUnavailableError) {
      context.logger.warn('Argus unavailable', { action, error });
      throw new UserFacingError('Argus is not responding right now. Please try again in a few minutes.');
    }
    if (error instanceof ArgusAuthError || error instanceof ArgusResponseError) {
      context.logger.error('Argus integration error', { action, error });
      throw new UserFacingError('The Argus integration is misconfigured. An admin has been notified in the bot logs.');
    }
    throw error;
  }
}
