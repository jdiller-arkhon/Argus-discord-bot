import { ConfigError, createLogger, registerCommands } from '@arkhon/shared';
import { createContext } from './app.js';
import { createCommands } from './commands/index.js';
import { loadArgusConfig } from './config.js';

// Registers slash commands without starting the bot. The bot also registers
// on startup; this is for CI or for checking registration in isolation.
try {
  const config = loadArgusConfig();
  const logger = createLogger('argus', config.env.LOG_LEVEL);
  const context = createContext(config, logger);
  const count = await registerCommands({
    token: config.env.DISCORD_TOKEN,
    applicationId: config.env.DISCORD_APPLICATION_ID,
    guildId: config.env.DISCORD_GUILD_ID,
    commands: createCommands(context),
  });
  context.store.db.close();
  logger.info('Registered slash commands', { count, scope: config.env.DISCORD_GUILD_ID ? 'guild' : 'global' });
} catch (error) {
  process.stderr.write(`${error instanceof ConfigError ? error.message : String(error)}\n`);
  process.exit(1);
}
