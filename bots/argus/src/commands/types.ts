import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';

/** One `/argus <name>` subcommand. */
export interface Subcommand {
  name: string;
  build(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}
