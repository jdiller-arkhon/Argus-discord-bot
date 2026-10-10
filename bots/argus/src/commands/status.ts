import { type ArgusContext, callArgus } from '../context.js';
import { statusEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export function statusSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'status',
    build: (sub) => sub.setName('status').setDescription('Show current Argus service health'),
    async execute(interaction) {
      // Status is public information, so the reply is visible to the channel.
      await interaction.deferReply();
      const status = await callArgus(context, 'getServiceStatus', () => context.argus.getServiceStatus());
      const channel = context.config.env.ARGUS_STATUS_CHANNEL_ID;
      await interaction.editReply({
        embeds: [statusEmbed(status)],
        content: channel ? `Live updates post in <#${channel}>.` : undefined,
        allowedMentions: { parse: [] },
      });
    },
  };
}
