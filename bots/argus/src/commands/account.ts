import { type ComponentHandler, customId, UserFacingError } from '@arkhon/shared';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import type { ArgusRole } from '../argus/types.js';
import { ArgusUserNotFoundError } from '../argus/client.js';
import { type ArgusContext, callArgus } from '../context.js';
import type { Subcommand } from './types.js';

const LINK_CODE_PATTERN = /^[A-Z0-9-]{6,32}$/;

const NEXT_STEPS: Record<ArgusRole, string> = {
  pilot: 'Try `/argus today`, `/argus missions`, `/argus schedule`, `/argus earnings`, or `/argus stats`.',
  client: 'Try `/argus jobs` to follow your bookings, or `/argus job id:<number>` for live progress.',
  admin: 'Try `/argus jobs` or `/argus status`.',
};

/** The `/argus link` confirmation. Exported for tests. */
export function linkConfirmation(displayName: string, role: ArgusRole, certaDisplayName: string | null): string {
  const lines = [
    `Linked to Argus as **${displayName}** (${role} account). ${NEXT_STEPS[role]}`,
    'Updates about your jobs arrive by DM. Choose which ones with `/argus alerts`.',
  ];
  if (certaDisplayName) {
    lines.push(
      role === 'pilot'
        ? `You're also linked to Certa as **${certaDisplayName}**, so log the flights you fly for Argus jobs with \`/log\`.`
        : `You're also linked to Certa as **${certaDisplayName}**.`,
    );
  }
  return lines.join('\n');
}

export function linkSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'link',
    build: (sub) =>
      sub
        .setName('link')
        .setDescription('Link your Discord account using a one-time code from Argus')
        .addStringOption((option) =>
          option.setName('code').setDescription('One-time code from Argus → Settings → Discord').setRequired(true).setMaxLength(32),
        ),
    async execute(interaction) {
      const code = interaction.options.getString('code', true).trim().toUpperCase().replace(/\s+/g, '');
      if (!LINK_CODE_PATTERN.test(code)) {
        throw new UserFacingError('That does not look like an Argus link code. Copy the code exactly as shown in Argus.');
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await callArgus(context, 'redeemLinkCode', () => context.argus.redeemLinkCode(code, interaction.user.id));
      context.store.upsertLink({
        discordUserId: interaction.user.id,
        argusUserId: result.argusUserId,
        displayName: result.displayName,
        role: result.role,
      });
      context.logger.info('Linked Argus account', { discordUserId: interaction.user.id, argusUserId: result.argusUserId, role: result.role });
      await interaction.editReply(
        linkConfirmation(result.displayName, result.role, context.certaLinks.displayName(interaction.user.id)),
      );
    },
  };
}

export const ACCOUNT_PREFIX = 'argus-account';

export function unlinkSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'unlink',
    build: (sub) => sub.setName('unlink').setDescription('Remove the link between your Discord and Argus accounts'),
    async execute(interaction) {
      if (!context.store.getLink(interaction.user.id)) {
        await interaction.reply({
          content: "Your Discord account isn't linked to Argus, so there was nothing to remove.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      // Unlinking changes the account on Argus too, so it is confirmed first.
      await interaction.reply({
        content:
          'Unlink Discord from Argus? The bot stops showing your Argus data and stops sending you DMs. ' +
          'Your Argus account and bot settings are kept, and you can link again any time.',
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(customId(ACCOUNT_PREFIX, 'unlink')).setLabel('Unlink').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(customId(ACCOUNT_PREFIX, 'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}

export function accountComponent(context: ArgusContext): ComponentHandler {
  return {
    prefix: ACCOUNT_PREFIX,
    async handleButton(interaction, [action]) {
      if (action === 'cancel') {
        await interaction.update({ content: 'Cancelled. You are still linked.', components: [] });
        return;
      }
      if (action !== 'unlink') return;
      const link = context.store.getLink(interaction.user.id);
      if (!link) {
        await interaction.update({ content: "You're already unlinked.", components: [] });
        return;
      }
      await interaction.update({ content: 'Unlinking…', components: [] });
      try {
        await context.argus.unlinkAccount(link.argusUserId);
      } catch (error) {
        // Already gone on Argus is fine; anything else is logged and the local
        // link is still removed, so the user is never stuck linked.
        if (!(error instanceof ArgusUserNotFoundError)) {
          context.logger.warn('Could not unlink on Argus; removed locally', { discordUserId: link.discordUserId, error });
        }
      }
      context.store.deleteLink(link.discordUserId);
      context.logger.info('Unlinked Argus account', { discordUserId: link.discordUserId });
      await interaction.editReply('Your Discord account is no longer linked to Argus, and Argus DMs have stopped.');
    },
  };
}
