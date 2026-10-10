import type { Server } from 'node:http';
import {
  ConfigError,
  createInteractionRouter,
  createLogger,
  postEmbeds,
  registerCommands,
  sendDm,
  sqliteJobRunStore,
  startScheduler,
} from '@arkhon/shared';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { createContext } from './app.js';
import { createCommands, createComponents } from './commands/index.js';
import { loadArgusConfig } from './config.js';
import { createEventDispatcher } from './events/dispatch.js';
import { createJobs } from './jobs.js';
import { createStatusMonitor, startStatusPolling } from './status/announce.js';
import { createWebhookServer, WEBHOOK_PATH } from './webhook/server.js';

async function main(): Promise<void> {
  const config = loadArgusConfig();
  const logger = createLogger('argus', config.env.LOG_LEVEL);
  const context = createContext(config, logger);
  const commands = createCommands(context);
  const { env } = config;

  logger.info('Starting Argus bot', {
    argusClient: env.ARGUS_CLIENT,
    timezone: config.timezone,
    tickets: context.tickets !== null,
    webhook: Boolean(env.ARGUS_WEBHOOK_SECRET),
  });

  // GuildMessages (not privileged; no message content) lets ticket threads
  // reopen when the user replies. Everything else needs only Guilds.
  const intents = [GatewayIntentBits.Guilds];
  if (context.tickets) intents.push(GatewayIntentBits.GuildMessages);
  const client = new Client({ intents, allowedMentions: { parse: [] } });
  client.on(Events.InteractionCreate, createInteractionRouter({ commands, components: createComponents(context), logger }));
  if (context.tickets) {
    const tickets = context.tickets;
    client.on(Events.MessageCreate, (message) => {
      tickets.onMessage(message).catch((error: unknown) => logger.warn('Ticket message tracking failed', { error }));
    });
  }

  const monitor = createStatusMonitor(context, client);
  let server: Server | undefined;
  if (env.ARGUS_WEBHOOK_SECRET) {
    const dispatch = createEventDispatcher({
      store: context.store,
      routes: env.ARGUS_EVENT_ROUTES,
      sendDm: (userId, embed) => sendDm(client, userId, { embeds: [embed] }, logger),
      postToChannel: (channelId, embed) => postEmbeds(client, channelId, [embed], logger),
      observeStatus: (status) => monitor.observe(status, 'webhook'),
      todayIso: () => context.now().toISODate()!,
      logger,
    });
    server = createWebhookServer({
      secret: env.ARGUS_WEBHOOK_SECRET,
      logger,
      isReady: () => client.isReady(),
      claimEvent: (eventId, type) => context.store.claimEvent(eventId, type),
      releaseEvent: (eventId) => context.store.releaseEvent(eventId),
      dispatch,
    });
    server.listen(env.ARGUS_WEBHOOK_PORT, env.ARGUS_WEBHOOK_HOST, () => {
      logger.info('Argus webhook server listening', { host: env.ARGUS_WEBHOOK_HOST, port: env.ARGUS_WEBHOOK_PORT, path: WEBHOOK_PATH });
    });
  } else {
    logger.info('Argus webhook server disabled (set ARGUS_WEBHOOK_SECRET)');
  }

  let stopScheduler: (() => void) | undefined;
  let stopPolling: (() => void) | undefined;
  client.once(Events.ClientReady, async (ready) => {
    logger.info('Connected to Discord', { user: ready.user.tag, guilds: ready.guilds.cache.size });
    if (context.tickets) logger.info('Loaded active tickets', { count: context.tickets.loadActiveChannels() });
    try {
      const count = await registerCommands({
        token: env.DISCORD_TOKEN,
        applicationId: env.DISCORD_APPLICATION_ID,
        guildId: env.DISCORD_GUILD_ID,
        commands,
      });
      logger.info('Registered slash commands', { count, scope: env.DISCORD_GUILD_ID ? 'guild' : 'global' });
    } catch (error) {
      logger.error('Failed to register slash commands', { error });
    }
    stopScheduler = startScheduler(createJobs(context), {
      timezone: config.timezone,
      store: sqliteJobRunStore(context.store.db),
      logger,
    });
    stopPolling = startStatusPolling(context, monitor);
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down', { signal });
    stopScheduler?.();
    stopPolling?.();
    server?.close();
    await client.destroy();
    context.store.db.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(env.DISCORD_TOKEN);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`Fatal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exit(1);
});
