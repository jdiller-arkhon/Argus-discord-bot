import { UserFacingError } from '@arkhon/shared';
import { MessageFlags } from 'discord.js';
import type { ArgusRole } from '../argus/types.js';
import { type ArgusContext, callArgus } from '../context.js';
import type { Subcommand } from './types.js';

const LINK_CODE_PATTERN = /^[A-Z0-9-]{6,32}$/;

const NEXT_STEPS: Record<ArgusRole, string> = {
  pilot: 'Try `/argus missions`, `/argus jobs`, `/argus earnings`, or `/argus credentials`.',
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

export function unlinkSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'unlink',
    build: (sub) => sub.setName('unlink').setDescription('Remove the link between your Discord and Argus accounts'),
    async execute(interaction) {
      const removed = context.store.deleteLink(interaction.user.id);
      if (removed) context.logger.info('Unlinked Argus account', { discordUserId: interaction.user.id });
      await interaction.reply({
        content: removed
          ? 'Your Discord account is no longer linked to Argus, and Argus DMs have stopped. Your Argus account is unchanged.'
          : "Your Discord account isn't linked to Argus, so there was nothing to remove.",
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}
