import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ArgusContext } from '../context.js';
import { faqEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export function helpSubcommand(context: ArgusContext): Subcommand {
  const { entries } = context.faq;
  return {
    name: 'help',
    build: (sub) =>
      sub
        .setName('help')
        .setDescription('Quick answers about Argus, and a way to reach support')
        .addStringOption((option) =>
          option
            .setName('topic')
            .setDescription('Jump to one question')
            .addChoices(...entries.map((entry) => ({ name: entry.question, value: entry.id }))),
        ),
    async execute(interaction) {
      const topic = interaction.options.getString('topic');
      const selected = topic ? entries.filter((entry) => entry.id === topic) : entries;
      const supportUrl = context.config.env.ARGUS_SUPPORT_URL;

      const button = context.tickets
        ? context.tickets.openButton('Open an Argus ticket')
        : new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(supportUrl).setLabel('Contact Arkhon support');

      await interaction.reply({
        embeds: [faqEmbed(selected.length > 0 ? selected : entries, context.tickets !== null, supportUrl)],
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button)],
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
