import type { ComponentHandler, SlashCommand } from '@arkhon/shared';
import { SlashCommandBuilder } from 'discord.js';
import type { ArgusContext } from '../context.js';
import { accountComponent, linkSubcommand, unlinkSubcommand } from './account.js';
import { alertsComponent, alertsSubcommand } from './alerts.js';
import { helpSubcommand } from './help.js';
import { jobsSubcommand, jobSubcommand } from './jobs.js';
import { missionsComponent, missionsSubcommand } from './missions.js';
import { credentialsSubcommand, earningsSubcommand } from './pilot.js';
import {
  dutySubcommand,
  pilotToolsComponent,
  scheduleSubcommand,
  statsSubcommand,
  stepSubcommand,
  todaySubcommand,
} from './pilot-tools.js';
import { statusSubcommand } from './status.js';
import type { Subcommand } from './types.js';

/** All bot features live under one `/argus` command so they group together in Discord. */
export function argusCommand(context: ArgusContext): SlashCommand {
  const subcommands: Subcommand[] = [
    linkSubcommand(context),
    unlinkSubcommand(context),
    statusSubcommand(context),
    todaySubcommand(context),
    scheduleSubcommand(context),
    jobsSubcommand(context),
    jobSubcommand(context),
    missionsSubcommand(context),
    earningsSubcommand(context),
    credentialsSubcommand(context),
    statsSubcommand(context),
    stepSubcommand(context),
    dutySubcommand(context),
    alertsSubcommand(context),
    helpSubcommand(context),
  ];
  const byName = new Map(subcommands.map((sub) => [sub.name, sub]));

  const data = new SlashCommandBuilder().setName('argus').setDescription('Argus: today, jobs, missions, field updates, payouts, status, and support');
  for (const sub of subcommands) data.addSubcommand((builder) => sub.build(builder));

  return {
    name: 'argus',
    data,
    async execute(interaction) {
      await byName.get(interaction.options.getSubcommand(true))?.execute(interaction);
    },
  };
}

export function createCommands(context: ArgusContext): SlashCommand[] {
  return [argusCommand(context)];
}

export function createComponents(context: ArgusContext): ComponentHandler[] {
  const components = [alertsComponent(context), missionsComponent(context), pilotToolsComponent(context), accountComponent(context)];
  if (context.tickets) components.push(context.tickets.component);
  return components;
}
