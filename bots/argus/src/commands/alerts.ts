import { type ComponentHandler, customId } from '@arkhon/shared';
import {
  ActionRowBuilder,
  type BaseMessageOptions,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
} from 'discord.js';
import type { ArgusRole } from '../argus/types.js';
import { type ArgusContext, requireLink } from '../context.js';
import { ARGUS_COLOR } from '../embeds.js';
import { alertPreferencesFromSelection, enabledAlerts } from '../events/routing.js';
import { alertsForRole } from '../events/types.js';
import type { Subcommand } from './types.js';

export const ALERTS_PREFIX = 'argus-alerts';

/** The alert preferences panel: current state plus a multi-select to change it. */
export function alertsPanel(role: ArgusRole, disabled: ReadonlySet<string>, saved = false): BaseMessageOptions {
  const alerts = alertsForRole(role);
  const on = new Set(enabledAlerts(disabled, alerts));
  const embed = new EmbedBuilder()
    .setTitle('Argus DM alerts')
    .setColor(ARGUS_COLOR)
    .setDescription(
      `${saved ? '✅ Saved. ' : ''}Select the alerts you want as DMs; anything left unselected is off.\n\n` +
        alerts.map((alert) => `${on.has(alert.type) ? '🔔' : '🔕'} **${alert.label}**: ${alert.description}`).join('\n'),
    )
    .setFooter({ text: 'Service status updates post in the status channel, not by DM.' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId(ALERTS_PREFIX, 'set'))
    .setPlaceholder('No alerts (all off)')
    .setMinValues(0)
    .setMaxValues(alerts.length)
    .addOptions(
      alerts.map((alert) =>
        new StringSelectMenuOptionBuilder()
          .setValue(alert.type)
          .setLabel(alert.label)
          .setDescription(alert.description)
          .setDefault(on.has(alert.type)),
      ),
    );
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)] };
}

export function alertsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'alerts',
    build: (sub) => sub.setName('alerts').setDescription('Choose which Argus updates you get by DM'),
    async execute(interaction) {
      const link = requireLink(context, interaction.user.id);
      await interaction.reply({
        ...alertsPanel(link.role, context.store.disabledAlerts(link.discordUserId)),
        flags: MessageFlags.Ephemeral,
      });
    },
  };
}

export function alertsComponent(context: ArgusContext): ComponentHandler {
  return {
    prefix: ALERTS_PREFIX,
    async handleSelect(interaction, [action]) {
      if (action !== 'set') return;
      const link = requireLink(context, interaction.user.id);
      const preferences = alertPreferencesFromSelection(interaction.values, alertsForRole(link.role));
      context.store.setAlertPreferences(link.discordUserId, preferences);
      context.logger.info('Alert preferences updated', { discordUserId: link.discordUserId, enabled: interaction.values });
      await interaction.update(alertsPanel(link.role, context.store.disabledAlerts(link.discordUserId), true));
    },
  };
}
