import { createTicketFlow, type Logger, TicketStore } from '@arkhon/shared';
import { DateTime } from 'luxon';
import { createArgusClient } from './argus/index.js';
import { createCertaLinkLookup } from './certa-links.js';
import type { ArgusConfig } from './config.js';
import type { ArgusContext } from './context.js';
import { openArgusDatabase } from './db.js';
import { ARGUS_COLOR } from './embeds.js';
import { loadFaq } from './faq.js';
import { createSettingsSource } from './settings.js';
import { ArgusStore } from './store.js';

/** Wires config, storage, the Argus client, the FAQ, and the shared ticket flow into one context. */
export async function createContext(config: ArgusConfig, logger: Logger): Promise<ArgusContext> {
  const db = await openArgusDatabase({ path: config.env.ARGUS_DB_PATH, d1BridgeUrl: config.env.D1_BRIDGE_URL });
  const tickets = config.tickets
    ? createTicketFlow({
        product: 'argus',
        productLabel: 'Argus',
        prefix: 'argus-ticket',
        store: new TicketStore(db),
        logger,
        supportChannelId: config.tickets.supportChannelId,
        staffRoleId: config.tickets.staffRoleId,
        mode: config.tickets.mode,
        categoryId: config.tickets.categoryId,
        archiveChannelId: config.tickets.archiveChannelId,
        referenceLabel: 'Argus job ID (optional)',
        color: ARGUS_COLOR,
      })
    : null;

  const argus = createArgusClient(config, db);
  return {
    config,
    store: new ArgusStore(db),
    argus,
    settings: createSettingsSource(argus, logger),
    faq: loadFaq(config.faqPath),
    certaLinks: createCertaLinkLookup(config.env.CERTA_DB_PATH, logger),
    tickets,
    logger,
    now: () => DateTime.now().setZone(config.timezone),
  };
}
