import { Colors } from '@arkhon/shared';
import { EmbedBuilder } from 'discord.js';
import { DateTime } from 'luxon';
import {
  type CredentialKind,
  type CredentialSummary,
  type Earnings,
  type JobDetail,
  type JobScope,
  type JobStatus,
  type JobStep,
  type JobSummary,
  JOB_STEPS,
  type MissionBoard,
  type OpenMission,
  type ServiceState,
  type ServiceStatus,
  type PilotStats,
  type StandingTier,
  type TodaySummary,
} from './argus/types.js';
import type { FaqEntry } from './faq.js';

/** Argus brand accent, used for product embeds alongside the shared status colors. */
export const ARGUS_COLOR = 0x7c3aed;

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** `2026-10-12` -> `Mon, Oct 12` (adds the year when it is not `todayIso`'s year). */
export function formatDate(iso: string, todayIso?: string): string {
  const date = DateTime.fromISO(iso);
  const sameYear = !todayIso || DateTime.fromISO(todayIso).year === date.year;
  return date.toFormat(sameYear ? 'ccc, LLL d' : 'ccc, LLL d, yyyy');
}

/** Time window ids such as `golden_hour` -> `Golden hour`. */
export function formatTimeWindow(window: string | null): string | null {
  if (!window) return null;
  const words = window.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function schedule(scheduledFor: string | null, timeWindow: string | null, todayIso: string): string {
  if (!scheduledFor) return 'Date not set';
  const window = formatTimeWindow(timeWindow);
  return `${formatDate(scheduledFor, todayIso)}${window ? ` (${window})` : ''}`;
}

export const JOB_STATUS_LABELS: Record<JobStatus, { emoji: string; label: string }> = {
  awaiting_payment: { emoji: '💳', label: 'Awaiting payment' },
  pending: { emoji: '🔎', label: 'Finding a pilot' },
  scheduled: { emoji: '📅', label: 'Scheduled' },
  in_progress: { emoji: '🛫', label: 'In progress' },
  review: { emoji: '📦', label: 'Ready for review' },
  completed: { emoji: '✅', label: 'Completed' },
  cancelled: { emoji: '✖️', label: 'Cancelled' },
  needs_review: { emoji: '⚠️', label: 'Under review by Arkhon' },
};

export const STEP_LABELS: Record<JobStep, string> = {
  en_route: 'Pilot en route',
  on_site: 'On site',
  preflight: 'Preflight checks',
  airspace_cleared: 'Airspace cleared',
  in_flight: 'In flight',
  landed: 'Landed',
  uploading: 'Uploading deliverables',
};

const PAYMENT_LABELS: Record<JobSummary['paymentStatus'], string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  refunded: 'Refunded',
  disputed: 'Disputed',
};

export function jobStatusText(status: JobStatus): string {
  const { emoji, label } = JOB_STATUS_LABELS[status];
  return `${emoji} ${label}`;
}

// ---------------------------------------------------------------- /argus jobs

export function jobLine(job: JobSummary, todayIso: string): string {
  const who = job.viewerRole === 'pilot' ? 'Client' : 'Pilot';
  const counterpart = job.counterpartName ?? (job.viewerRole === 'client' ? 'not assigned yet' : 'unknown');
  const money = job.viewerRole === 'pilot' ? `${formatUsd(job.amountCents)} payout` : formatUsd(job.amountCents);
  const live = job.status === 'in_progress' && job.latestStep ? ` · ${STEP_LABELS[job.latestStep]}` : '';
  return (
    `**#${job.id} · ${job.title}**\n` +
    `${jobStatusText(job.status)}${live} · ${schedule(job.scheduledFor, job.timeWindow, todayIso)}\n` +
    `${job.serviceType} · ${job.locality} · ${money} · ${who}: ${counterpart}`
  );
}

export function jobsEmbed(displayName: string, scope: JobScope, jobs: readonly JobSummary[], todayIso: string): EmbedBuilder {
  const title = scope === 'active' ? `Active Argus jobs: ${displayName}` : `Recent Argus jobs: ${displayName}`;
  const embed = new EmbedBuilder().setTitle(title).setColor(ARGUS_COLOR);
  if (jobs.length === 0) {
    return embed.setDescription(
      scope === 'active'
        ? 'Nothing in progress right now. Recent work is under `/argus jobs scope:recent`.'
        : 'No completed or cancelled jobs yet.',
    );
  }
  return embed
    .setDescription(jobs.slice(0, 10).map((job) => jobLine(job, todayIso)).join('\n\n'))
    .setFooter({ text: 'Details and live progress: /argus job id:<number>' });
}

// ---------------------------------------------------------------- /argus job

/** Live progress checklist; only meaningful once a pilot is working the job. */
export function stepTimeline(job: Pick<JobDetail, 'status' | 'steps'>): string | null {
  if (!['in_progress', 'review', 'completed'].includes(job.status) && job.steps.length === 0) return null;
  const done = new Map(job.steps.map((step) => [step.step, step.at]));
  const finished = job.status === 'review' || job.status === 'completed';
  return JOB_STEPS.map((step) => {
    const at = done.get(step);
    if (at) return `✅ ${STEP_LABELS[step]} · <t:${Math.floor(Date.parse(at) / 1000)}:t>`;
    return `${finished ? '➖' : '▫️'} ${STEP_LABELS[step]}`;
  }).join('\n');
}

export function jobDetailEmbed(job: JobDetail, todayIso: string, appUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`#${job.id} · ${job.title}`)
    .setColor(job.status === 'cancelled' ? Colors.neutral : job.status === 'needs_review' ? Colors.warning : ARGUS_COLOR)
    .setDescription(`${jobStatusText(job.status)}\n${job.serviceType} · ${job.locality}`)
    .setURL(appUrl)
    .addFields(
      { name: 'Scheduled', value: schedule(job.scheduledFor, job.timeWindow, todayIso), inline: true },
      {
        name: job.viewerRole === 'pilot' ? 'Your payout' : 'Price',
        value: `${formatUsd(job.amountCents)} · ${PAYMENT_LABELS[job.paymentStatus]}`,
        inline: true,
      },
      {
        name: job.viewerRole === 'pilot' ? 'Client' : 'Pilot',
        value: job.counterpartName ?? (job.viewerRole === 'client' ? 'Not assigned yet' : 'Unknown'),
        inline: true,
      },
      { name: 'Images', value: job.imageCount > 0 ? String(job.imageCount) : 'Not applicable', inline: true },
      { name: 'Add-ons', value: job.addOns.length > 0 ? job.addOns.map(addOnLabel).join(', ') : 'None', inline: true },
    );

  const timeline = stepTimeline(job);
  if (timeline) embed.addFields({ name: 'Progress', value: timeline });
  if (job.deliverables.length > 0) {
    embed.addFields({
      name: `Deliverables (${job.deliverables.length})`,
      value: job.deliverables
        .slice(0, 10)
        .map((d) => `• ${d.name} (${d.kind}${d.imageCount > 1 ? `, ${plural(d.imageCount, 'image')}` : ''})`)
        .join('\n'),
    });
  }
  if (job.status === 'review' && job.viewerRole === 'client') {
    embed.addFields({ name: 'Next step', value: 'Review and approve the deliverables in Argus to close the job.' });
  }
  return embed.setFooter({ text: 'Open Argus for files, messages, and changes.' });
}

const ADD_ON_LABELS: Record<string, string> = {
  photos: 'High-res photos',
  '4kvideo': '4K video',
  orthomosaic: 'Orthomosaic map',
  '3dmodel': '3D model',
  report: 'Inspection report',
};

export function addOnLabel(id: string): string {
  return ADD_ON_LABELS[id] ?? formatTimeWindow(id) ?? id;
}

// ---------------------------------------------------------------- /argus missions

export const TIER_LABELS: Record<StandingTier, string> = {
  verified: 'Verified',
  established: 'Established',
  trusted: 'Trusted',
  elite: 'Elite',
};

export function missionLine(mission: OpenMission, todayIso: string): string {
  const details = [
    mission.serviceType,
    mission.locality,
    mission.distanceMi !== null ? `${mission.distanceMi.toFixed(1)} mi` : null,
    schedule(mission.scheduledFor, mission.timeWindow, todayIso),
    mission.imageCount > 0 ? plural(mission.imageCount, 'image') : null,
  ].filter(Boolean);
  const addOns = mission.addOns.length > 0 ? `\nAdd-ons: ${mission.addOns.map(addOnLabel).join(', ')}` : '';
  return `**#${mission.id} · ${mission.title}** · ${formatUsd(mission.payoutCents)} payout\n${details.join(' · ')}${addOns}`;
}

export function missionsEmbed(board: MissionBoard, todayIso: string): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Open Argus missions').setColor(ARGUS_COLOR);
  const tier = board.tier ? `Standing: **${TIER_LABELS[board.tier]}**. ` : '';
  if (board.missions.length === 0) {
    return embed.setDescription(`${tier}No open missions in your area right now. Turn on mission alerts with \`/argus alerts\`.`);
  }
  const intro = board.canAccept
    ? `${tier}Pick a mission below to review and accept it.`
    : `${tier}⚠️ You can't accept missions until your credentials are verified and current. See \`/argus credentials\`.`;
  return embed
    .setDescription(`${intro}\n\n${board.missions.slice(0, 10).map((m) => missionLine(m, todayIso)).join('\n\n')}`)
    .setFooter({
      text:
        board.missions.length > 10
          ? `Showing 10 of ${board.missions.length}. All of them are in the menu below.`
          : 'Higher standing tiers see new missions sooner.',
    });
}

export function missionConfirmEmbed(mission: OpenMission, todayIso: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Accept mission #${mission.id}?`)
    .setColor(Colors.warning)
    .setDescription(
      `${missionLine(mission, todayIso)}\n\nAccepting commits you to fly this job on the scheduled date. ` +
        'Check the site and airspace in Argus before you confirm.',
    );
}

// ---------------------------------------------------------------- /argus earnings

const PAYOUT_STATUS_LABELS: Record<Earnings['recentPayouts'][number]['status'], string> = {
  pending: '🕓 Pending',
  in_transit: '🚚 In transit',
  paid: '✅ Paid',
  failed: '🔴 Failed',
};

export function earningsEmbed(displayName: string, earnings: Earnings, todayIso: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Argus earnings: ${displayName}`)
    .setColor(Colors.success)
    .addFields(
      { name: 'Pending', value: formatUsd(earnings.pendingCents), inline: true },
      { name: 'Available for instant payout', value: formatUsd(earnings.availableCents), inline: true },
      { name: 'Completed missions', value: String(earnings.completedMissions), inline: true },
      { name: 'Paid, last 30 days', value: formatUsd(earnings.paidLast30DaysCents), inline: true },
      { name: 'Paid, year to date', value: formatUsd(earnings.paidYearToDateCents), inline: true },
    );
  const failed = earnings.recentPayouts.some((payout) => payout.status === 'failed');
  if (failed) {
    embed.setColor(Colors.danger).setDescription('🔴 A recent payout failed. Check your payout account in Argus.');
  }
  embed.addFields({
    name: 'Recent payouts',
    value:
      earnings.recentPayouts.length > 0
        ? earnings.recentPayouts
            .slice(0, 5)
            .map(
              (payout) =>
                `${PAYOUT_STATUS_LABELS[payout.status]} · ${formatUsd(payout.amountCents)} · ${formatDate(payout.date, todayIso)}` +
                (payout.missionTitle ? ` · ${payout.missionTitle}` : ''),
            )
            .join('\n')
        : 'No payouts yet.',
  });
  return embed.setFooter({ text: 'Payouts are released when the client approves the job.' });
}

// ---------------------------------------------------------------- /argus credentials

export const CREDENTIAL_LABELS: Record<CredentialKind, string> = {
  faa_part107: 'FAA Part 107',
  insurance: 'Liability insurance',
  id: 'Government ID',
  drone_reg: 'Drone registration',
};

/** Days from `todayIso` to the expiry date (negative once expired). */
export function daysUntil(expiresAt: string, todayIso: string): number {
  return Math.round(DateTime.fromISO(expiresAt).diff(DateTime.fromISO(todayIso), 'days').days);
}

export const EXPIRY_WARNING_DAYS = 30;

export function credentialLine(credential: CredentialSummary['credentials'][number], todayIso: string): string {
  const label = CREDENTIAL_LABELS[credential.kind];
  const mode = credential.insuranceMode === 'on_demand' ? ' (on-demand, per flight)' : '';
  if (credential.status === 'missing') return `🔴 **${label}**: not uploaded`;
  if (credential.status === 'rejected') return `🔴 **${label}**: rejected. Upload a new copy in Argus.`;
  if (credential.status === 'pending') return `🕓 **${label}**${mode}: waiting for review`;
  if (!credential.expiresAt) return `🟢 **${label}**${mode}: approved`;

  const days = daysUntil(credential.expiresAt, todayIso);
  const date = formatDate(credential.expiresAt, todayIso);
  if (days < 0) return `🔴 **${label}**${mode}: expired ${date}`;
  if (days <= EXPIRY_WARNING_DAYS) return `🟡 **${label}**${mode}: expires ${date} (${days === 0 ? 'today' : `in ${plural(days, 'day')}`})`;
  return `🟢 **${label}**${mode}: approved, expires ${date}`;
}

const VERIFICATION_LABELS: Record<CredentialSummary['verificationStatus'], string> = {
  unverified: '🔴 Not verified',
  pending: '🕓 Verification in progress',
  verified: '🟢 Verified',
  rejected: '🔴 Verification rejected',
};

export function credentialsEmbed(displayName: string, summary: CredentialSummary, todayIso: string): EmbedBuilder {
  const lines = summary.credentials.map((credential) => credentialLine(credential, todayIso));
  const attention = lines.some((line) => line.startsWith('🔴')) || summary.paused;
  const warning = lines.some((line) => line.startsWith('🟡'));
  const embed = new EmbedBuilder()
    .setTitle(`Argus pilot credentials: ${displayName}`)
    .setColor(attention ? Colors.danger : warning ? Colors.warning : Colors.success)
    .addFields(
      { name: 'Verification', value: VERIFICATION_LABELS[summary.verificationStatus], inline: true },
      { name: 'Standing', value: summary.standingTier ? TIER_LABELS[summary.standingTier] : 'None yet', inline: true },
      { name: 'Documents', value: lines.length > 0 ? lines.join('\n') : 'Nothing uploaded yet.' },
    );
  if (summary.paused) {
    embed.setDescription('⏸️ Your standing is **paused** because a credential lapsed. Renew it to restore perks and mission access.');
  }
  return embed.setFooter({ text: 'Document numbers are never shown here. Upload and renew in Argus.' });
}

// ---------------------------------------------------------------- status

export const STATE_LABELS: Record<ServiceState, { emoji: string; label: string; color: number }> = {
  operational: { emoji: '🟢', label: 'All systems operational', color: Colors.success },
  maintenance: { emoji: '🛠️', label: 'Scheduled maintenance', color: Colors.primary },
  degraded: { emoji: '🟡', label: 'Degraded performance', color: Colors.warning },
  outage: { emoji: '🔴', label: 'Service outage', color: Colors.danger },
};

export function statusEmbed(status: ServiceStatus): EmbedBuilder {
  const { emoji, label, color } = STATE_LABELS[status.state];
  const embed = new EmbedBuilder()
    .setTitle(`${emoji} Argus: ${label}`)
    .setColor(color)
    .setTimestamp(new Date(status.updatedAt));
  if (status.summary) embed.setDescription(status.summary);
  if (status.components.length > 0) {
    embed.addFields({
      name: 'Components',
      value: status.components.map((c) => `${STATE_LABELS[c.state].emoji} ${c.name}`).join('\n'),
    });
  }
  return embed.setFooter({ text: 'Last updated' });
}

export function statusChangeEmbed(from: ServiceState, status: ServiceStatus): EmbedBuilder {
  const recovered = status.state === 'operational';
  return statusEmbed(status).setTitle(
    recovered
      ? `🟢 Argus recovered: ${STATE_LABELS.operational.label.toLowerCase()}`
      : `${STATE_LABELS[status.state].emoji} Argus status: ${STATE_LABELS[status.state].label} (was ${STATE_LABELS[from].label.toLowerCase()})`,
  );
}

// ---------------------------------------------------------------- help

/** Total question + answer characters shown inline before switching to a question list. */
export const FAQ_INLINE_LIMIT = 5000;

export function faqEmbed(entries: readonly FaqEntry[], ticketsEnabled: boolean, supportUrl: string): EmbedBuilder {
  const footer = ticketsEnabled
    ? 'Still stuck? Open a private ticket with the button below.'
    : `Still stuck? Contact Arkhon support: ${supportUrl}`;
  if (entries.length === 1) {
    const [entry] = entries;
    return new EmbedBuilder().setTitle(entry!.question).setColor(ARGUS_COLOR).setDescription(entry!.answer).setFooter({ text: footer });
  }
  const embed = new EmbedBuilder().setTitle('Argus help').setColor(ARGUS_COLOR).setFooter({ text: footer });
  // Discord caps an embed at 6000 characters in total. A long FAQ falls back
  // to a list of questions; each answer is one `topic` away.
  const size = entries.reduce((total, entry) => total + entry.question.length + entry.answer.length, 0);
  if (size > FAQ_INLINE_LIMIT) {
    return embed.setDescription(
      `Pick a question with \`/argus help topic:\`\n\n${entries.map((entry) => `• ${entry.question}`).join('\n')}`,
    );
  }
  for (const entry of entries) embed.addFields({ name: entry.question, value: entry.answer });
  return embed;
}

// ---------------------------------------------------------------- /argus today and the daily digest

/** Compact one-liner for a job in a list. */
function shortJob(job: JobSummary): string {
  const window = formatTimeWindow(job.timeWindow);
  const live = job.status === 'in_progress' && job.latestStep ? ` · ${STEP_LABELS[job.latestStep]}` : '';
  return `**#${job.id} · ${job.title}**${window ? ` · ${window}` : ''}\n${jobStatusText(job.status)}${live} · ${job.locality}`;
}

/**
 * Today at a glance. Used by `/argus today` and, with a greeting title, by the
 * daily digest DM, so both always agree.
 */
export function todayEmbed(summary: TodaySummary, title = 'Today on Argus'): EmbedBuilder {
  const day = DateTime.fromISO(summary.date).toFormat('cccc, LLLL d');
  const embed = new EmbedBuilder().setTitle(title).setColor(ARGUS_COLOR).setDescription(`${day} · ${summary.timezone.replace(/_/g, ' ')}`);

  embed.addFields({
    name: summary.todayJobs.length ? `Today's jobs (${summary.todayJobs.length})` : "Today's jobs",
    value: summary.todayJobs.length ? summary.todayJobs.slice(0, 6).map(shortJob).join('\n\n') : 'Nothing scheduled today.',
  });
  if (summary.upcomingJobs > 0) {
    embed.addFields({ name: 'Coming up', value: `${plural(summary.upcomingJobs, 'more job')} in the next 7 days · \`/argus schedule\`` });
  }
  if (summary.awaitingReview > 0) {
    embed.addFields({
      name: 'Waiting on you',
      value: `${plural(summary.awaitingReview, 'job')} ready for your review. Approve in Argus so your pilot gets paid.`,
    });
  }

  const pilot = summary.pilot;
  if (pilot) {
    embed.addFields(
      { name: 'Duty', value: pilot.onDuty ? '🟢 On duty' : '⚪ Off duty · `/argus duty`', inline: true },
      {
        name: 'Open missions',
        value: pilot.openMissions
          ? `${pilot.openMissions} · best ${formatUsd(pilot.bestPayoutCents)}${pilot.canAccept ? '' : ' (can’t accept yet)'}`
          : 'None right now',
        inline: true,
      },
      { name: 'Pending payouts', value: formatUsd(pilot.pendingPayoutCents), inline: true },
    );
    if (pilot.credentialAlerts.length > 0) {
      embed
        .setColor(pilot.credentialAlerts.some((c) => c.status !== 'approved' || (c.expiresAt !== null && c.expiresAt < summary.date)) ? Colors.danger : Colors.warning)
        .addFields({
          name: 'Documents needing attention',
          value: pilot.credentialAlerts.map((c) => credentialLine(c, summary.date)).join('\n'),
        });
    }
  }
  return embed;
}

// ---------------------------------------------------------------- /argus schedule

/** The next `days` days of jobs, grouped by date (jobs without a date are listed last). */
export function scheduleEmbed(displayName: string, jobs: readonly JobSummary[], todayIso: string, days = 7): EmbedBuilder {
  const end = DateTime.fromISO(todayIso).plus({ days: days - 1 }).toISODate()!;
  const inRange = jobs
    .filter((job) => job.scheduledFor === null || (job.scheduledFor >= todayIso && job.scheduledFor <= end))
    .sort((a, b) => (a.scheduledFor ?? '9999').localeCompare(b.scheduledFor ?? '9999') || a.id - b.id);
  const embed = new EmbedBuilder().setTitle(`Your next ${days} days: ${displayName}`).setColor(ARGUS_COLOR);
  if (inRange.length === 0) return embed.setDescription('Nothing scheduled. Find work with `/argus missions`.');

  const groups = new Map<string, JobSummary[]>();
  for (const job of inRange) {
    const key = job.scheduledFor ?? 'unscheduled';
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  for (const [key, list] of [...groups].slice(0, 25)) {
    const name =
      key === 'unscheduled'
        ? 'Date not set'
        : key === todayIso
          ? `Today · ${formatDate(key, todayIso)}`
          : key === DateTime.fromISO(todayIso).plus({ days: 1 }).toISODate()
            ? `Tomorrow · ${formatDate(key, todayIso)}`
            : formatDate(key, todayIso);
    embed.addFields({ name, value: list.slice(0, 5).map(shortJob).join('\n\n').slice(0, 1024) });
  }
  return embed.setFooter({ text: 'Post field updates with /argus step' });
}

// ---------------------------------------------------------------- /argus stats

function stars(rating: number): string {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(Math.max(0, 5 - full));
}

export function statsEmbed(displayName: string, stats: PilotStats): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`Pilot stats: ${displayName}`)
    .setColor(stats.paused ? Colors.warning : ARGUS_COLOR)
    .addFields(
      { name: 'Completed missions', value: String(stats.completedMissions), inline: true },
      { name: 'Active now', value: String(stats.activeMissions), inline: true },
      {
        name: 'Rating',
        value: stats.rating === null ? 'No reviews yet' : `${stats.rating.toFixed(2)} ${stars(stats.rating)} (${plural(stats.reviewCount, 'review')})`,
        inline: true,
      },
      { name: 'Paid this month', value: formatUsd(stats.earnedThisMonthCents), inline: true },
      { name: 'Paid this year', value: formatUsd(stats.earnedThisYearCents), inline: true },
      { name: 'Standing', value: `${stats.tier ? TIER_LABELS[stats.tier] : 'Not rated yet'}${stats.paused ? ' (paused)' : ''}`, inline: true },
    );
  if (stats.nextTier) {
    embed.addFields({
      name: `Road to ${TIER_LABELS[stats.nextTier.tier]}`,
      value: stats.nextTier.requirements.map((r) => `${r.met ? '✅' : '▫️'} ${r.label}: ${r.have} / ${r.need}`).join('\n'),
    });
  }
  if (stats.recentReviews.length > 0) {
    embed.addFields({
      name: 'Latest reviews',
      value: stats.recentReviews
        .map((r) => `${stars(r.rating)} · ${formatDate(r.date)}${r.body ? `\n> ${r.body}` : ''}`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  return embed;
}

// ---------------------------------------------------------------- /argus duty

export function dutyEmbed(onDuty: boolean, changed = false): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(onDuty ? '🟢 You are on duty' : '⚪ You are off duty')
    .setColor(onDuty ? Colors.success : Colors.neutral)
    .setDescription(
      (changed ? 'Updated on Argus. ' : '') +
        (onDuty
          ? 'You can be offered and accept new missions within your hours and service area.'
          : 'New missions are not offered to you. Jobs you already accepted are unaffected.'),
    );
}
