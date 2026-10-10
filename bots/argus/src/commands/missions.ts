import { Colors, type ComponentHandler, customId, UserFacingError } from '@arkhon/shared';
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { MissionBoard, OpenMission } from '../argus/types.js';
import { type ArgusContext, callArgus, requirePilot } from '../context.js';
import { formatDate, formatUsd, missionConfirmEmbed, missionsEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export const MISSIONS_PREFIX = 'argus-mission';

export const missionIds = {
  pick: () => customId(MISSIONS_PREFIX, 'pick'),
  confirm: (missionId: number) => customId(MISSIONS_PREFIX, 'confirm', String(missionId)),
  cancel: () => customId(MISSIONS_PREFIX, 'cancel'),
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The mission board: embed plus, when the pilot may accept, a menu to pick one. */
export function missionBoardMessage(board: MissionBoard, todayIso: string): BaseMessageOptions {
  const components =
    board.canAccept && board.missions.length > 0
      ? [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(missionIds.pick())
              .setPlaceholder('Choose a mission to review and accept')
              .addOptions(
                board.missions.slice(0, 25).map((mission) =>
                  new StringSelectMenuOptionBuilder()
                    .setValue(String(mission.id))
                    .setLabel(clip(`#${mission.id} · ${mission.title}`, 100))
                    .setDescription(
                      clip(
                        [formatUsd(mission.payoutCents), mission.locality, mission.scheduledFor ? formatDate(mission.scheduledFor, todayIso) : null]
                          .filter(Boolean)
                          .join(' · '),
                        100,
                      ),
                    ),
                ),
              ),
          ),
        ]
      : [];
  return { embeds: [missionsEmbed(board, todayIso)], components };
}

/** Second step: details plus explicit Confirm / Cancel buttons. Nothing changes in Argus until Confirm. */
export function missionConfirmMessage(mission: OpenMission, todayIso: string): BaseMessageOptions {
  return {
    embeds: [missionConfirmEmbed(mission, todayIso)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(missionIds.confirm(mission.id)).setLabel('Confirm and accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(missionIds.cancel()).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export function missionsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'missions',
    build: (sub) => sub.setName('missions').setDescription('Pilots: open missions you can accept right now'),
    async execute(interaction) {
      const link = requirePilot(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const board = await callArgus(context, 'listOpenMissions', () => context.argus.listOpenMissions(link.argusUserId));
      await interaction.editReply(missionBoardMessage(board, context.now().toISODate()!));
    },
  };
}

export function missionsComponent(context: ArgusContext): ComponentHandler {
  return {
    prefix: MISSIONS_PREFIX,

    async handleSelect(interaction, [action]) {
      if (action !== 'pick') return;
      const link = requirePilot(context, interaction.user.id);
      const missionId = Number(interaction.values[0]);
      await interaction.deferUpdate();
      // Re-read the board: the mission may have been taken since the list was shown.
      const board = await callArgus(context, 'listOpenMissions', () => context.argus.listOpenMissions(link.argusUserId));
      const mission = board.missions.find((m) => m.id === missionId);
      const today = context.now().toISODate()!;
      if (!mission) {
        await interaction.editReply({
          ...missionBoardMessage(board, today),
          content: `Mission #${missionId} is no longer open. Here is the current board.`,
        });
        return;
      }
      await interaction.editReply({ ...missionConfirmMessage(mission, today), content: '' });
    },

    async handleButton(interaction, [action, arg]) {
      if (action === 'cancel') {
        await interaction.update({ content: 'Cancelled. Nothing was changed in Argus.', embeds: [], components: [] });
        return;
      }
      if (action !== 'confirm') return;
      const missionId = Number(arg);
      if (!Number.isInteger(missionId) || missionId <= 0) throw new UserFacingError('That button is no longer valid.');
      const link = requirePilot(context, interaction.user.id);

      // Remove the buttons first so a double click cannot submit twice.
      await interaction.update({ content: `Accepting mission #${missionId}…`, components: [] });
      const result = await callArgus(context, 'acceptMission', () => context.argus.acceptMission(link.argusUserId, missionId));
      context.logger.info('Mission accepted', { discordUserId: link.discordUserId, missionId, jobId: result.jobId });
      await interaction.editReply({
        content: '',
        components: [],
        embeds: [
          new EmbedBuilder()
            .setTitle(`✅ Mission accepted: ${result.title}`)
            .setColor(Colors.success)
            .setDescription(
              `It is now job **#${result.jobId}**${result.scheduledFor ? `, scheduled ${formatDate(result.scheduledFor, context.now().toISODate()!)}` : ''}.\n` +
                `Follow it with \`/argus job id:${result.jobId}\`, and check the site and airspace in Argus before you fly.`,
            ),
        ],
      });
    },
  };
}
