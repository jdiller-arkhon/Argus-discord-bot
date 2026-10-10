import { ConfigError, signBody } from '@arkhon/shared';
import { DateTime } from 'luxon';
import { MockArgusClient } from '../argus/mock-client.js';
import { SERVICE_STATES, type ServiceState } from '../argus/types.js';
import { loadArgusConfig } from '../config.js';
import { openArgusDatabase } from '../db.js';
import { sampleEvent } from '../events/samples.js';
import { EVENT_TYPES, isEventType } from '../events/types.js';
import { ArgusStore } from '../store.js';
import { SIGNATURE_HEADER, WEBHOOK_PATH } from '../webhook/server.js';

const USAGE = `Local development helpers (reads ../../.env):

  pnpm argus:event <type> [--discord <discordUserId>] [--state <state>]
      Signs a sample Argus event with ARGUS_WEBHOOK_SECRET and POSTs it to the
      running bot. --discord makes it a personal event for that linked user.
      Types: ${EVENT_TYPES.join(', ')}

  pnpm argus:mock-status <${SERVICE_STATES.join('|')}> [summary...]
      ARGUS_CLIENT=mock only: sets what the mock status endpoint reports. The
      bot's poller announces it after ARGUS_STATUS_CONFIRMATIONS polls.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function sendEvent(args: string[]): Promise<void> {
  const [type] = args;
  if (!isEventType(type)) throw new Error(`Unknown event type "${type ?? ''}".\n\n${USAGE}`);
  const config = loadArgusConfig();
  const secret = config.env.ARGUS_WEBHOOK_SECRET;
  if (!secret) throw new Error('Set ARGUS_WEBHOOK_SECRET in .env first.');

  let userId: string | null = null;
  const discordId = option(args, 'discord');
  if (discordId) {
    const db = openArgusDatabase(config.env.ARGUS_DB_PATH);
    const link = new ArgusStore(db).getLink(discordId);
    db.close();
    if (!link) throw new Error(`Discord user ${discordId} is not linked. Run /argus link first.`);
    userId = link.argusUserId;
  }
  const state = option(args, 'state');
  if (state !== undefined && !(SERVICE_STATES as readonly string[]).includes(state)) {
    throw new Error(`--state must be one of ${SERVICE_STATES.join(', ')}`);
  }

  const body = JSON.stringify(sampleEvent(type, { userId, state: state as ServiceState | undefined }));
  const host = config.env.ARGUS_WEBHOOK_HOST === '0.0.0.0' ? '127.0.0.1' : config.env.ARGUS_WEBHOOK_HOST;
  const url = `http://${host}:${config.env.ARGUS_WEBHOOK_PORT}${WEBHOOK_PATH}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(body, secret) },
    body,
  });
  process.stdout.write(`${response.status} ${await response.text()}\n`);
}

function setMockStatus(args: string[]): void {
  const [state, ...summary] = args;
  if (!state || !(SERVICE_STATES as readonly string[]).includes(state)) {
    throw new Error(`State must be one of ${SERVICE_STATES.join(', ')}.\n\n${USAGE}`);
  }
  const config = loadArgusConfig();
  if (config.env.ARGUS_CLIENT !== 'mock') throw new Error('mock-status only works with ARGUS_CLIENT=mock.');
  const db = openArgusDatabase(config.env.ARGUS_DB_PATH);
  new MockArgusClient(db, { timezone: config.timezone, now: () => DateTime.now().setZone(config.timezone) }).setServiceStatus(
    state as ServiceState,
    summary.length > 0 ? summary.join(' ') : null,
  );
  db.close();
  process.stdout.write(`Mock Argus status set to ${state}.\n`);
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'event') await sendEvent(rest);
  else if (command === 'status') setMockStatus(rest);
  else process.stdout.write(`${USAGE}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError || error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
