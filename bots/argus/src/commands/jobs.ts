import { MessageFlags } from 'discord.js';
import { type ArgusContext, callArgus, requireLink } from '../context.js';
import { jobDetailEmbed, jobsEmbed } from '../embeds.js';
import type { Subcommand } from './types.js';

export function jobsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'jobs',
    build: (sub) =>
      sub
        .setName('jobs')
        .setDescription('Your Argus jobs: bookings if you are a client, assigned missions if you are a pilot')
        .addStringOption((option) =>
          option
            .setName('scope')
            .setDescription('Which jobs (default: active)')
            .addChoices({ name: 'Active', value: 'active' }, { name: 'Recently finished', value: 'recent' }),
        ),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      const scope = interaction.options.getString('scope') === 'recent' ? 'recent' : 'active';
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const jobs = await callArgus(context, 'listJobs', () => context.argus.listJobs(link.argusUserId, scope));
      await interaction.editReply({ embeds: [jobsEmbed(link.displayName, scope, jobs, context.now().toISODate()!)] });
    },
  };
}

export function jobSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'job',
    build: (sub) =>
      sub
        .setName('job')
        .setDescription('One job in detail: live progress, schedule, and deliverables')
        .addIntegerOption((option) => option.setName('id').setDescription('Job number, e.g. 1042').setRequired(true).setMinValue(1)),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      const jobId = interaction.options.getInteger('id', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const job = await callArgus(context, 'getJob', () => context.argus.getJob(link.argusUserId, jobId));
      await interaction.editReply({
        embeds: [jobDetailEmbed(job, context.now().toISODate()!, context.config.env.ARGUS_APP_URL)],
      });
    },
  };
}
