import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  type ModalSubmitInteraction,
  REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type RepliableInteraction,
  Routes,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Logger } from './logger.js';

export interface SlashCommand {
  /** Command name; must match `data.name`. */
  name: string;
  data: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * Handles buttons, string select menus, and modal submissions whose
 * `customId` starts with `${prefix}:`. Everything after the prefix is passed
 * as `args`.
 */
export interface ComponentHandler {
  prefix: string;
  handleButton?(interaction: ButtonInteraction, args: string[]): Promise<void>;
  handleSelect?(interaction: StringSelectMenuInteraction, args: string[]): Promise<void>;
  handleModal?(interaction: ModalSubmitInteraction, args: string[]): Promise<void>;
}

/** Builds a component custom ID that {@link createInteractionRouter} can route. */
export function customId(prefix: string, ...args: string[]): string {
  const id = [prefix, ...args].join(':');
  if (id.length > 100) throw new Error(`customId too long (${id.length} > 100): ${id}`);
  return id;
}

/**
 * Error whose message is safe to show the user. Throw from a handler to end
 * it with a friendly ephemeral reply instead of the generic failure message.
 */
export class UserFacingError extends Error {
  override name = 'UserFacingError';
}

/** Replies ephemerally, or follows up if the interaction was already answered. */
export async function replyEphemeral(interaction: RepliableInteraction, content: string): Promise<void> {
  if (interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content, embeds: [], components: [] });
  } else if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

const GENERIC_FAILURE = 'Something went wrong handling that. Please try again in a moment.';

/**
 * Returns an `interactionCreate` listener that dispatches slash commands,
 * buttons, string select menus and modal submits, and converts thrown errors
 * into ephemeral replies.
 */
export function createInteractionRouter(options: {
  commands: readonly SlashCommand[];
  components?: readonly ComponentHandler[];
  logger: Logger;
}): (interaction: Interaction) => Promise<void> {
  const commands = new Map(options.commands.map((command) => [command.name, command]));
  const components = new Map((options.components ?? []).map((handler) => [handler.prefix, handler]));

  const fail = async (interaction: RepliableInteraction, error: unknown, context: Record<string, unknown>) => {
    if (error instanceof UserFacingError) {
      options.logger.debug('User-facing error', { ...context, message: error.message });
    } else {
      options.logger.error('Interaction handler failed', { ...context, error });
    }
    const message = error instanceof UserFacingError ? error.message : GENERIC_FAILURE;
    try {
      await replyEphemeral(interaction, message);
    } catch (replyError) {
      options.logger.warn('Could not send failure reply', { ...context, error: replyError });
    }
  };

  return async (interaction) => {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      const context = {
        command: interaction.commandName,
        subcommand: interaction.options.getSubcommand(false),
        user: interaction.user.id,
      };
      try {
        await command.execute(interaction);
      } catch (error) {
        await fail(interaction, error, context);
      }
      return;
    }

    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      const [prefix, ...args] = interaction.customId.split(':');
      const handler = prefix === undefined ? undefined : components.get(prefix);
      if (!handler) return;
      const context = { customId: interaction.customId, user: interaction.user.id };
      try {
        if (interaction.isButton() && handler.handleButton) await handler.handleButton(interaction, args);
        else if (interaction.isStringSelectMenu() && handler.handleSelect) await handler.handleSelect(interaction, args);
        else if (interaction.isModalSubmit() && handler.handleModal) await handler.handleModal(interaction, args);
      } catch (error) {
        await fail(interaction, error, context);
      }
    }
  };
}

/**
 * Registers slash commands. With a guild ID they update instantly in that
 * guild; without one they are registered globally (can take up to an hour).
 */
export async function registerCommands(options: {
  token: string;
  applicationId: string;
  guildId?: string;
  commands: readonly SlashCommand[];
}): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(options.token);
  const body = options.commands.map((command) => command.data.toJSON());
  const route = options.guildId
    ? Routes.applicationGuildCommands(options.applicationId, options.guildId)
    : Routes.applicationCommands(options.applicationId);
  await rest.put(route, { body });
  return body.length;
}
