import { MessageFlags } from 'discord.js';
import { type ArgusContext, callArgus, requirePilot } from '../context.js';
import { credentialsEmbed, earningsEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export function earningsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'earnings',
    build: (sub) => sub.setName('earnings').setDescription('Pilots: pending and recent payouts'),
    async execute(interaction) {
      const link = requirePilot(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const earnings = await callArgus(context, 'getEarnings', () => context.argus.getEarnings(link.argusUserId));
      await interaction.editReply({ embeds: [earningsEmbed(link.displayName, earnings, context.now().toISODate()!)] });
    },
  };
}

export function credentialsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'credentials',
    build: (sub) => sub.setName('credentials').setDescription('Pilots: verification status and credential expiry dates'),
    async execute(interaction) {
      const link = requirePilot(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const summary = await callArgus(context, 'getCredentials', () => context.argus.getCredentials(link.argusUserId));
      await interaction.editReply({ embeds: [credentialsEmbed(link.displayName, summary, context.now().toISODate()!)] });
    },
  };
}
