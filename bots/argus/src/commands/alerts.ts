import { type ComponentHandler, customId, UserFacingError } from '@arkhon/shared';
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
import type { ArgusRole, BotSettings } from '../argus/types.js';
import { type ArgusContext, callArgus, requireLink } from '../context.js';
import { ARGUS_COLOR, formatUsd } from '../embeds.js';
import { disabledAfterSelection, enabledAlerts } from '../events/routing.js';
import { alertsForRole, isPersonalAlertType, PERSONAL_ALERTS, type PersonalAlertType } from '../events/types.js';
import type { Subcommand } from './types.js';

export const ALERTS_PREFIX = 'argus-alerts';

/** Disabled alert types <-> a short hex bitmask over PERSONAL_ALERTS, so a Save button can carry the choice. */
export function encodeDisabled(disabled: readonly string[]): string {
  let mask = 0;
  PERSONAL_ALERTS.forEach((alert, i) => {
    if (disabled.includes(alert.type)) mask |= 1 << i;
  });
  return mask.toString(16);
}

export function decodeDisabled(hex: string): PersonalAlertType[] {
  if (!/^[0-9a-f]{1,4}$/.test(hex)) throw new UserFacingError('That button is no longer valid. Run `/argus alerts` again.');
  const mask = parseInt(hex, 16);
  return PERSONAL_ALERTS.filter((_, i) => (mask & (1 << i)) !== 0).map((alert) => alert.type);
}

/** Where pilots find the rest of the bot settings. */
export function dashboardUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, '')}/pilot/discord`;
}

function otherSettingsLine(role: ArgusRole, settings: BotSettings, appUrl: string): string {
  const parts: string[] = [];
  const { minPayoutCents, maxDistanceMi } = settings.missionAlerts;
  if (role !== 'client' && (minPayoutCents !== null || maxDistanceMi !== null)) {
    const filters = [
      minPayoutCents !== null ? `at least ${formatUsd(minPayoutCents)}` : null,
      maxDistanceMi !== null ? `within ${maxDistanceMi} mi` : null,
    ].filter(Boolean);
    parts.push(`Mission alerts: only ${filters.join(', ')}.`);
  }
  const zone = settings.timezone.replace(/_/g, ' ');
  if (settings.quietHours.enabled) {
    parts.push(`Quiet hours: ${settings.quietHours.start}–${settings.quietHours.end} (${zone}).`);
  }
  if (settings.digest.enabled) {
    parts.push(`Daily digest: around ${String(settings.digest.hour).padStart(2, '0')}:00 (${zone}).`);
  }
  const where =
    role === 'client'
      ? 'Change quiet hours and filters in Argus.'
      : `Mission filters, quiet hours and the daily digest: ${dashboardUrl(appUrl)}`;
  return [...parts, where].join('\n');
}

/**
 * The alerts panel. `pending` is an unsaved selection: it is previewed with
 * Save / Cancel, because saving changes the user's settings on Argus.
 */
export function alertsPanel(
  role: ArgusRole,
  settings: BotSettings,
  appUrl: string,
  state: { pending?: readonly string[]; saved?: boolean } = {},
): BaseMessageOptions {
  const alerts = alertsForRole(role);
  const disabled = new Set<string>(state.pending ?? settings.disabledAlerts);
  const on = new Set(enabledAlerts(disabled, alerts));
  const intro = state.pending
    ? '**Not saved yet.** Press Save to update your settings on Argus.'
    : `${state.saved ? '✅ Saved. ' : ''}Select the alerts you want as DMs; anything left unselected is off.`;
  const embed = new EmbedBuilder()
    .setTitle('Argus DM alerts')
    .setColor(ARGUS_COLOR)
    .setDescription(
      `${intro}\n\n` +
        alerts.map((alert) => `${on.has(alert.type) ? '🔔' : '🔕'} **${alert.label}**: ${alert.description}`).join('\n') +
        `\n\n${otherSettingsLine(role, settings, appUrl)}`,
    )
    .setFooter({ text: 'Service status updates post in the status channel, not by DM.' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId(ALERTS_PREFIX, 'pick'))
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
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
  ];
  if (state.pending) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(customId(ALERTS_PREFIX, 'save', encodeDisabled(state.pending)))
          .setLabel('Save')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(customId(ALERTS_PREFIX, 'cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { embeds: [embed], components };
}

export function alertsSubcommand(context: ArgusContext): Subcommand {
  return {
    name: 'alerts',
    build: (sub) => sub.setName('alerts').setDescription('Choose which Argus updates you get by DM'),
    async execute(interaction) {
      const link = await requireLink(context, interaction.user.id);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const settings = await callArgus(context, 'getBotSettings', () => context.settings.get(link.argusUserId), link.discordUserId);
      await interaction.editReply(alertsPanel(link.role, settings, context.config.env.ARGUS_APP_URL));
    },
  };
}

export function alertsComponent(context: ArgusContext): ComponentHandler {
  const appUrl = () => context.config.env.ARGUS_APP_URL;
  return {
    prefix: ALERTS_PREFIX,

    async handleSelect(interaction, [action]) {
      if (action !== 'pick') return;
      const link = await requireLink(context, interaction.user.id);
      const settings = await context.settings.get(link.argusUserId);
      const pending = disabledAfterSelection(settings.disabledAlerts, interaction.values, alertsForRole(link.role));
      await interaction.update(alertsPanel(link.role, settings, appUrl(), { pending }));
    },

    async handleButton(interaction, [action, arg]) {
      const link = await requireLink(context, interaction.user.id);
      if (action === 'cancel') {
        const settings = await context.settings.get(link.argusUserId);
        await interaction.update(alertsPanel(link.role, settings, appUrl()));
        return;
      }
      if (action !== 'save' || arg === undefined) return;
      const disabledAlerts = decodeDisabled(arg).filter(isPersonalAlertType);
      await interaction.deferUpdate();
      // Re-read so a quiet-hours change made on the website meanwhile is kept.
      const current = await callArgus(context, 'getBotSettings', () => context.settings.get(link.argusUserId), link.discordUserId);
      const saved = await callArgus(
        context,
        'updateBotSettings',
        () => context.settings.update(link.argusUserId, { ...current, disabledAlerts }),
        link.discordUserId,
      );
      context.logger.info('Alert preferences updated', { discordUserId: link.discordUserId, disabledAlerts });
      await interaction.editReply(alertsPanel(link.role, saved, appUrl(), { saved: true }));
    },
  };
}
