import { Colors, type ComponentHandler, customId, UserFacingError } from '@arkhon/shared';
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { JOB_STEPS, type JobStep } from '../argus/types.js';
import { type ArgusContext, callArgus, requireLink, requirePilot } from '../context.js';
import { dutyEmbed, scheduleEmbed, STEP_LABELS, statsEmbed, todayEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export const TOOLS_PREFIX = 'argus-tools';

export const toolIds = {
  stepConfirm: (jobId: number, step: JobStep) => customId(TOOLS_PREFIX, 'step', String(jobId), step),
  dutyConfirm: (onDuty: boolean) => customId(TOOLS_PREFIX, 'duty', onDuty ? 'on' : 'off'),
  cancel: () => customId(TOOLS_PREFIX, 'cancel'),
};

function confirmRow(confirmId: string, label: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(label).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(toolIds.cancel()).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

/** Field step confirmation. Nothing changes on Argus until Confirm. */
export function stepConfirmMessage(jobId: number, step: JobStep): BaseMessageOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(`Post "${STEP_LABELS[step]}" on job #${jobId}?`)
        .setColor(Colors.warning)
        .setDescription(
          'Your client sees this on their live timeline' +
            (step === 'en_route' || step === 'in_flight' ? ' and gets an email and push notification.' : '.') +
            ' Steps only move forward, so earlier steps are skipped if you jump ahead.',
        ),
    ],
    components: [confirmRow(toolIds.stepConfirm(jobId, step), 'Post update')],
  };
}

export function todaySubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'today',
    build: (sub) => sub.setName('today').setDescription('Today at a glance: jobs, open missions, payouts, documents'),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const summary = await callArgus(context, 'getToday', () => context.argus.getToday(link.argusUserId), link.discordUserId);
      await interaction.editReply({ embeds: [todayEmbed(summary)] });
    },
  };
}

export function scheduleSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'schedule',
    build: (sub) => sub.setName('schedule').setDescription('Your jobs for the next 7 days, grouped by day'),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const [jobs, settings] = await Promise.all([
        callArgus(context, 'listJobs', () => context.argus.listJobs(link.argusUserId, 'active'), link.discordUserId),
        context.settings.get(link.argusUserId),
      ]);
      // "Today" in the user's own time zone, from their bot settings.
      const today = context.now().setZone(settings.timezone).toISODate() ?? context.now().toISODate()!;
      await interaction.editReply({ embeds: [scheduleEmbed(link.displayName, jobs, today)] });
    },
  };
}

export function stepSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'step',
    build: (sub) =>
      sub
        .setName('step')
        .setDescription('Pilots: post a live field update on a job')
        .addIntegerOption((option) => option.setName('job').setDescription('Job number, e.g. 1042').setRequired(true).setMinValue(1))
        .addStringOption((option) =>
          option
            .setName('step')
            .setDescription('Where you are in the job')
            .setRequired(true)
            .addChoices(...JOB_STEPS.map((step) => ({ name: STEP_LABELS[step], value: step }))),
        ),
    async execute(interaction) {
      requirePilot(context, interaction.user.id);
      const jobId = interaction.options.getInteger('job', true);
      const step = interaction.options.getString('step', true) as JobStep;
      if (!JOB_STEPS.includes(step)) throw new UserFacingError('Pick a step from the list.');
      await interaction.reply({ ...stepConfirmMessage(jobId, step), flags: MessageFlags.Ephemeral });
    },
  };
}

export function statsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'stats',
    build: (sub) => sub.setName('stats').setDescription('Pilots: rating, reviews, earnings and next standing tier'),
    async execute(interaction) {
      const link = requirePilot(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const stats = await callArgus(context, 'getStats', () => context.argus.getStats(link.argusUserId), link.discordUserId);
      await interaction.editReply({ embeds: [statsEmbed(link.displayName, stats)] });
    },
  };
}

export function dutySubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'duty',
    build: (sub) =>
      sub
        .setName('duty')
        .setDescription('Pilots: see or change whether you are on duty for new missions')
        .addStringOption((option) =>
          option.setName('set').setDescription('Leave empty to just check').addChoices({ name: 'On duty', value: 'on' }, { name: 'Off duty', value: 'off' }),
        ),
    async execute(interaction) {
      const link = requirePilot(context, interaction.user.id);
      const wanted = interaction.options.getString('set');
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const onDuty = await callArgus(context, 'getDuty', () => context.argus.getDuty(link.argusUserId), link.discordUserId);
      if (wanted === null || (wanted === 'on') === onDuty) {
        await interaction.editReply({ embeds: [dutyEmbed(onDuty)] });
        return;
      }
      const next = wanted === 'on';
      await interaction.editReply({
        embeds: [
          dutyEmbed(onDuty).setFooter({ text: next ? 'Go on duty? You will be offered new missions.' : 'Go off duty? New missions stop.' }),
        ],
        components: [confirmRow(toolIds.dutyConfirm(next), next ? 'Go on duty' : 'Go off duty')],
      });
    },
  };
}

export function pilotToolsComponent(context: ArgusContext): ComponentHandler {
  return {
    prefix: TOOLS_PREFIX,
    async handleButton(interaction, [action, a, b]) {
      if (action === 'cancel') {
        await interaction.update({ content: 'Cancelled. Nothing was changed in Argus.', embeds: [], components: [] });
        return;
      }
      const link = requirePilot(context, interaction.user.id);

      if (action === 'step') {
        const jobId = Number(a);
        const step = b as JobStep;
        if (!Number.isInteger(jobId) || !JOB_STEPS.includes(step)) throw new UserFacingError('That button is no longer valid.');
        await interaction.update({ content: 'Posting your update…', components: [] });
        const result = await callArgus(
          context,
          'postJobStep',
          () => context.argus.postJobStep(link.argusUserId, jobId, step, null),
          link.discordUserId,
        );
        await interaction.editReply({
          content: '',
          components: [],
          embeds: [
            new EmbedBuilder()
              .setTitle(`✅ ${STEP_LABELS[result.step]} · job #${result.jobId}`)
              .setColor(Colors.success)
              .setDescription(`Posted <t:${Math.floor(Date.parse(result.at) / 1000)}:t>. See the timeline with \`/argus job id:${result.jobId}\`.`),
          ],
        });
        return;
      }

      if (action === 'duty') {
        const next = a === 'on';
        await interaction.update({ content: next ? 'Going on duty…' : 'Going off duty…', components: [] });
        const onDuty = await callArgus(context, 'setDuty', () => context.argus.setDuty(link.argusUserId, next), link.discordUserId);
        context.logger.info('Duty changed from Discord', { discordUserId: link.discordUserId, onDuty });
        await interaction.editReply({ content: '', components: [], embeds: [dutyEmbed(onDuty, true)] });
      }
    },
  };
}
