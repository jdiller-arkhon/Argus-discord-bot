import { Colors } from '@arkhon/shared';
import { EmbedBuilder } from 'discord.js';
import {
  ARGUS_COLOR,
  CREDENTIAL_LABELS,
  formatDate,
  formatUsd,
  jobStatusText,
  plural,
  statusEmbed,
  STEP_LABELS,
} from '../embeds.js';
import type { ArgusEvent } from './types.js';

const DISPUTE_LABELS = {
  open: 'opened',
  reviewing: 'under review',
  resolved: 'resolved',
  dismissed: 'dismissed',
} as const;

/**
 * Builds the Discord message for an event. Channel posts (broadcast events)
 * and DMs use the same embed; personal events include a footer pointing at
 * `/argus alerts` so users can turn them off.
 */
export function formatEvent(event: ArgusEvent, todayIso: string): EmbedBuilder {
  const embed = buildEventEmbed(event, todayIso).setTimestamp(new Date(event.occurredAt));
  if (event.userId !== null && event.type !== 'service.status_changed') {
    embed.setFooter({ text: 'Manage these DMs with /argus alerts' });
  }
  return embed;
}

function buildEventEmbed(event: ArgusEvent, todayIso: string): EmbedBuilder {
  switch (event.type) {
    case 'service.status_changed':
      return statusEmbed(event.data);

    case 'mission.posted': {
      const d = event.data;
      const details = [
        d.serviceType,
        d.locality,
        d.distanceMi !== null ? `${d.distanceMi.toFixed(1)} mi away` : null,
        d.scheduledFor ? formatDate(d.scheduledFor, todayIso) : null,
      ].filter(Boolean);
      return new EmbedBuilder()
        .setTitle(`🛰️ New mission: ${d.title}`)
        .setColor(ARGUS_COLOR)
        .setDescription(`**${formatUsd(d.payoutCents)} payout**\n${details.join(' · ')}\n\nReview and accept it with \`/argus missions\`.`);
    }

    case 'job.status_changed': {
      const d = event.data;
      const color = d.to === 'cancelled' ? Colors.neutral : d.to === 'needs_review' ? Colors.warning : d.to === 'completed' ? Colors.success : ARGUS_COLOR;
      return new EmbedBuilder()
        .setTitle(`Job #${d.jobId}: ${d.title}`)
        .setColor(color)
        .setDescription(`${d.from ? `${jobStatusText(d.from)} → ` : ''}**${jobStatusText(d.to)}**\n\nDetails: \`/argus job id:${d.jobId}\``);
    }

    case 'job.step': {
      const d = event.data;
      return new EmbedBuilder()
        .setTitle(`Job #${d.jobId}: ${STEP_LABELS[d.step]}`)
        .setColor(ARGUS_COLOR)
        .setDescription(`**${d.title}**${d.note ? `\n> ${d.note}` : ''}\n\nFollow along with \`/argus job id:${d.jobId}\``);
    }

    case 'job.deliverables_ready': {
      const d = event.data;
      return new EmbedBuilder()
        .setTitle(`📦 Deliverables ready: ${d.title}`)
        .setColor(Colors.success)
        .setDescription(
          `${plural(d.deliverableCount, 'deliverable')} uploaded for job #${d.jobId}. ` +
            'Review and approve them in Argus to close the job.',
        );
    }

    case 'payout.paid': {
      const d = event.data;
      return new EmbedBuilder()
        .setTitle(`💸 Payout sent: ${formatUsd(d.amountCents)}`)
        .setColor(Colors.success)
        .setDescription(d.missionTitle ? `For **${d.missionTitle}**.` : 'Your payout is on its way to your bank.');
    }

    case 'payout.failed': {
      const d = event.data;
      return new EmbedBuilder()
        .setTitle(`🔴 Payout failed: ${formatUsd(d.amountCents)}`)
        .setColor(Colors.danger)
        .setDescription(`${d.reason ? `${d.reason}\n\n` : ''}Update your payout account in Argus so we can retry.`);
    }

    case 'credential.expiring': {
      const d = event.data;
      const label = CREDENTIAL_LABELS[d.kind];
      const when = d.daysRemaining <= 0 ? 'today' : `in ${plural(d.daysRemaining, 'day')}`;
      return new EmbedBuilder()
        .setTitle(`⏰ ${label} expires ${when}`)
        .setColor(d.daysRemaining <= 7 ? Colors.danger : Colors.warning)
        .setDescription(
          `Expires ${formatDate(d.expiresAt, todayIso)}. Upload the renewal in Argus to keep accepting missions. ` +
            'Status: `/argus credentials`.',
        );
    }

    case 'credential.reviewed': {
      const d = event.data;
      const approved = d.status === 'approved';
      return new EmbedBuilder()
        .setTitle(`${approved ? '🟢' : '🔴'} ${CREDENTIAL_LABELS[d.kind]} ${approved ? 'approved' : 'rejected'}`)
        .setColor(approved ? Colors.success : Colors.danger)
        .setDescription(d.note ?? (approved ? 'Thanks, you are all set.' : 'Upload a new copy in Argus.'));
    }

    case 'dispute.updated': {
      const d = event.data;
      return new EmbedBuilder()
        .setTitle(`⚖️ Dispute #${d.disputeId} ${DISPUTE_LABELS[d.status]}`)
        .setColor(d.status === 'resolved' || d.status === 'dismissed' ? Colors.neutral : Colors.warning)
        .setDescription(
          [d.jobId ? `Job #${d.jobId}.` : null, d.resolution, 'See the full thread in Argus.'].filter(Boolean).join('\n\n'),
        );
    }
  }
}
