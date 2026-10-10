import { createInteractionRouter, silentLogger } from '@arkhon/shared';
import type { Interaction } from 'discord.js';
import { DateTime } from 'luxon';
import { MockArgusClient } from '../src/argus/mock-client.js';
import type { CertaLinkLookup } from '../src/certa-links.js';
import { createCommands, createComponents } from '../src/commands/index.js';
import { type ArgusConfig, DEFAULT_FAQ_PATH, loadArgusConfig } from '../src/config.js';
import type { ArgusContext } from '../src/context.js';
import { openArgusDatabase } from '../src/db.js';
import { loadFaq } from '../src/faq.js';
import { ArgusStore } from '../src/store.js';

export const USER = '123456789012345678';
export const OTHER_USER = '223456789012345678';
export const TODAY = '2026-10-10';
export const NOW = DateTime.fromISO(`${TODAY}T12:00`, { zone: 'America/Denver' });

export const validEnv = {
  DISCORD_TOKEN: 'token',
  DISCORD_APPLICATION_ID: '345678901234567890',
  ARGUS_CLIENT: 'mock',
};

export interface Reply {
  content?: string;
  embeds?: { toJSON(): EmbedJson }[];
  components?: { toJSON(): { components: { custom_id?: string; type: number; options?: { value: string; default?: boolean }[]; url?: string }[] } }[];
  flags?: number;
}

export interface EmbedJson {
  title?: string;
  description?: string;
  url?: string;
  footer?: { text: string };
  fields?: { name: string; value: string }[];
  color?: number;
}

/** Records what a handler sent back, mimicking discord.js reply state. */
export class FakeInteraction {
  deferred = false;
  replied = false;
  ephemeral = false;
  replies: Reply[] = [];
  values: string[] = [];
  customId = '';
  user = { id: USER, displayName: 'Ava' };

  constructor(
    readonly kind: 'command' | 'button' | 'select',
    props: Record<string, unknown>,
  ) {
    Object.assign(this, props);
  }

  isChatInputCommand() {
    return this.kind === 'command';
  }
  isButton() {
    return this.kind === 'button';
  }
  isStringSelectMenu() {
    return this.kind === 'select';
  }
  isModalSubmit() {
    return false;
  }
  inCachedGuild() {
    return false;
  }
  async reply(reply: Reply) {
    this.replied = true;
    this.ephemeral = Boolean(reply.flags);
    this.replies.push(reply);
  }
  async deferReply(options?: { flags?: number }) {
    this.deferred = true;
    this.ephemeral = Boolean(options?.flags);
  }
  async deferUpdate() {
    this.deferred = true;
  }
  async editReply(reply: Reply | string) {
    this.replies.push(typeof reply === 'string' ? { content: reply } : reply);
  }
  async followUp(reply: Reply) {
    this.replies.push(reply);
  }
  async update(reply: Reply) {
    this.replied = true;
    this.replies.push(reply);
  }

  get last(): Reply {
    return this.replies.at(-1) ?? {};
  }
  get lastEmbed(): EmbedJson | undefined {
    return this.last.embeds?.[0]?.toJSON();
  }
  /** Every component in the last reply, flattened. */
  get lastComponents() {
    return (this.last.components ?? []).flatMap((row) => row.toJSON().components);
  }
}

export function command(subcommand: string, options: Record<string, string | number> = {}, userId = USER) {
  return new FakeInteraction('command', {
    commandName: 'argus',
    user: { id: userId, displayName: 'Ava' },
    options: {
      getSubcommand: () => subcommand,
      getString: (key: string) => (typeof options[key] === 'string' ? options[key] : null),
      getInteger: (key: string) => (typeof options[key] === 'number' ? options[key] : null),
    },
  });
}

export function button(customId: string, userId = USER) {
  return new FakeInteraction('button', { customId, user: { id: userId, displayName: 'Ava' } });
}

export function select(customId: string, values: string[], userId = USER) {
  return new FakeInteraction('select', { customId, values, user: { id: userId, displayName: 'Ava' } });
}

export function testConfig(env: Record<string, string> = {}): ArgusConfig {
  return loadArgusConfig({ ...validEnv, ...env });
}

export function setup(options: { env?: Record<string, string>; certaName?: string | null } = {}) {
  const db = openArgusDatabase(':memory:');
  const config = testConfig(options.env);
  const mock = new MockArgusClient(db, { timezone: 'America/Denver', now: () => NOW });
  const certaLinks: CertaLinkLookup = { displayName: () => options.certaName ?? null, close: () => {} };
  const context: ArgusContext = {
    config,
    store: new ArgusStore(db),
    argus: mock,
    faq: loadFaq(DEFAULT_FAQ_PATH),
    certaLinks,
    tickets: null,
    logger: silentLogger,
    now: () => NOW,
  };
  const route = createInteractionRouter({ commands: createCommands(context), components: createComponents(context), logger: silentLogger });
  const run = async (interaction: FakeInteraction) => {
    await route(interaction as unknown as Interaction);
    return interaction;
  };
  return { context, mock, db, run };
}
