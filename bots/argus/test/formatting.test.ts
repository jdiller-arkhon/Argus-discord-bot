import { Colors } from '@arkhon/shared';
import { describe, expect, it } from 'vitest';
import type { CredentialSummary, Earnings, JobDetail, JobSummary, MissionBoard, OpenMission } from '../src/argus/types.js';
import { linkConfirmation } from '../src/commands/account.js';
import { alertsPanel } from '../src/commands/alerts.js';
import { missionBoardMessage, missionConfirmMessage, missionIds } from '../src/commands/missions.js';
import {
  credentialLine,
  credentialsEmbed,
  daysUntil,
  earningsEmbed,
  FAQ_INLINE_LIMIT,
  faqEmbed,
  formatTimeWindow,
  formatUsd,
  jobDetailEmbed,
  jobLine,
  jobsEmbed,
  missionsEmbed,
  statusChangeEmbed,
  statusEmbed,
  stepTimeline,
} from '../src/embeds.js';
import { formatEvent } from '../src/events/format.js';
import { sampleEvent } from '../src/events/samples.js';
import { EVENT_TYPES } from '../src/events/types.js';
import { DEFAULT_BOT_SETTINGS } from '../src/argus/types.js';
import { TODAY } from './fixtures.js';

const APP = 'https://arkhonindustries.com/app';

const clientJob: JobSummary = {
  id: 1042,
  title: 'Roof inspection: 1420 Pine St',
  serviceType: 'Roof Inspection',
  status: 'in_progress',
  paymentStatus: 'paid',
  scheduledFor: TODAY,
  timeWindow: 'morning',
  amountCents: 37_500,
  locality: 'Boulder, CO',
  viewerRole: 'client',
  counterpartName: 'Ava R.',
  latestStep: 'in_flight',
};

const detail: JobDetail = {
  ...clientJob,
  imageCount: 40,
  addOns: ['report', 'thermal'],
  steps: [
    { step: 'en_route', at: '2026-10-10T15:00:00Z' },
    { step: 'on_site', at: '2026-10-10T15:20:00Z' },
  ],
  deliverables: [],
  createdAt: '2026-10-01T12:00:00Z',
};

const mission: OpenMission = {
  id: 512,
  title: 'Listing photos: 4-bed home',
  serviceType: 'Real Estate Photography',
  locality: 'Golden, CO',
  distanceMi: 12.44,
  payoutCents: 18_000,
  scheduledFor: '2026-10-12',
  timeWindow: 'golden_hour',
  imageCount: 25,
  addOns: ['4kvideo'],
  postedAt: '2026-10-10T12:00:00Z',
};

describe('helpers', () => {
  it('formats money, time windows, and day counts', () => {
    expect(formatUsd(1_234_550)).toBe('$12,345.50');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatTimeWindow('golden_hour')).toBe('Golden hour');
    expect(formatTimeWindow(null)).toBeNull();
    expect(daysUntil('2026-11-09', TODAY)).toBe(30);
    expect(daysUntil('2026-10-09', TODAY)).toBe(-1);
  });
});

describe('/argus jobs formatting', () => {
  it('shows status, live step, schedule, price, and pilot for a client', () => {
    expect(jobLine(clientJob, TODAY)).toBe(
      '**#1042 · Roof inspection: 1420 Pine St**\n' +
        '🛫 In progress · In flight · Sat, Oct 10 (Morning)\n' +
        'Roof Inspection · Boulder, CO · $375.00 · Pilot: Ava R.',
    );
  });

  it('labels the amount as a payout and names the client for a pilot', () => {
    const line = jobLine({ ...clientJob, viewerRole: 'pilot', counterpartName: 'Client 5678', amountCents: 26_500, status: 'scheduled' }, TODAY);
    expect(line).toContain('$265.00 payout · Client: Client 5678');
    expect(line).not.toContain('In flight');
  });

  it('says when no pilot is assigned and adds the year for other years', () => {
    const line = jobLine({ ...clientJob, status: 'pending', counterpartName: null, scheduledFor: '2027-01-04', timeWindow: null }, TODAY);
    expect(line).toContain('🔎 Finding a pilot · Mon, Jan 4, 2027');
    expect(line).toContain('Pilot: not assigned yet');
  });

  it('builds the list embed, with helpful empty states', () => {
    const embed = jobsEmbed('Ava', 'active', [clientJob], TODAY).toJSON();
    expect(embed.title).toBe('Active Argus jobs: Ava');
    expect(embed.footer?.text).toContain('/argus job id:');
    expect(jobsEmbed('Ava', 'active', [], TODAY).toJSON().description).toContain('scope:recent');
    expect(jobsEmbed('Ava', 'recent', [], TODAY).toJSON().description).toBe('No completed or cancelled jobs yet.');
  });

  it('caps the list at 10 jobs', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...clientJob, id: i + 1 }));
    expect(jobsEmbed('Ava', 'active', many, TODAY).toJSON().description?.match(/\*\*#/g)).toHaveLength(10);
  });
});

describe('/argus job formatting', () => {
  it('shows fields, add-ons, and a progress checklist', () => {
    const embed = jobDetailEmbed(detail, TODAY, APP).toJSON();
    expect(embed.title).toBe('#1042 · Roof inspection: 1420 Pine St');
    expect(embed.url).toBe(APP);
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Price).toBe('$375.00 · Paid');
    expect(fields.Pilot).toBe('Ava R.');
    expect(fields['Add-ons']).toBe('Inspection report, Thermal');
    expect(fields.Progress).toContain('✅ Pilot en route · <t:1791644400:t>');
    expect(fields.Progress).toContain('▫️ In flight');
  });

  it('marks unreached steps as skipped once the job is finished and prompts the client to approve', () => {
    const review = { ...detail, status: 'review' as const, deliverables: [{ name: 'Edited stills (zip)', kind: 'image' as const, imageCount: 25 }] };
    const embed = jobDetailEmbed(review, TODAY, APP).toJSON();
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Progress).toContain('➖ Landed');
    expect(fields['Deliverables (1)']).toBe('• Edited stills (zip) (image, 25 images)');
    expect(fields['Next step']).toContain('approve');
  });

  it('omits the checklist before work starts', () => {
    expect(stepTimeline({ status: 'scheduled', steps: [] })).toBeNull();
  });

  it('uses payout wording and warning color where relevant', () => {
    const embed = jobDetailEmbed({ ...detail, viewerRole: 'pilot', status: 'needs_review' }, TODAY, APP).toJSON();
    expect(embed.fields?.map((f) => f.name)).toContain('Your payout');
    expect(embed.color).toBe(Colors.warning);
  });
});

describe('/argus missions formatting', () => {
  const board: MissionBoard = { canAccept: true, tier: 'established', missions: [mission] };

  it('lists missions with payout, distance, schedule, and add-ons', () => {
    const embed = missionsEmbed(board, TODAY).toJSON();
    expect(embed.description).toContain('Standing: **Established**.');
    expect(embed.description).toContain('**#512 · Listing photos: 4-bed home** · $180.00 payout');
    expect(embed.description).toContain('Real Estate Photography · Golden, CO · 12.4 mi · Mon, Oct 12 (Golden hour) · 25 images');
    expect(embed.description).toContain('Add-ons: 4K video');
  });

  it('offers a pick menu only when the pilot can accept', () => {
    const open = missionBoardMessage(board, TODAY);
    const menu = (open.components?.[0] as { toJSON(): { components: { custom_id: string; options: { value: string; label: string; description: string }[] }[] } })
      .toJSON().components[0]!;
    expect(menu.custom_id).toBe(missionIds.pick());
    expect(menu.options[0]).toMatchObject({ value: '512', label: '#512 · Listing photos: 4-bed home', description: '$180.00 · Golden, CO · Mon, Oct 12' });

    const blocked = missionBoardMessage({ ...board, canAccept: false }, TODAY);
    expect(blocked.components).toEqual([]);
    expect((blocked.embeds?.[0] as { toJSON(): { description: string } }).toJSON().description).toContain("can't accept missions");
  });

  it('requires an explicit confirm button before accepting', () => {
    const message = missionConfirmMessage(mission, TODAY);
    const buttons = (message.components?.[0] as { toJSON(): { components: { custom_id: string; label: string }[] } }).toJSON().components;
    expect(buttons.map((b) => b.custom_id)).toEqual([missionIds.confirm(512), missionIds.cancel()]);
    expect((message.embeds?.[0] as { toJSON(): { title: string } }).toJSON().title).toBe('Accept mission #512?');
  });

  it('has an empty state that points at alerts', () => {
    expect(missionsEmbed({ canAccept: true, tier: null, missions: [] }, TODAY).toJSON().description).toContain('/argus alerts');
  });
});

describe('/argus earnings formatting', () => {
  const earnings: Earnings = {
    pendingCents: 87_000,
    availableCents: 61_000,
    paidLast30DaysCents: 52_500,
    paidYearToDateCents: 73_500,
    completedMissions: 4,
    recentPayouts: [
      { id: 'po_1', missionTitle: 'Ranch boundary survey', amountCents: 61_000, status: 'pending', date: '2026-10-09' },
      { id: 'po_2', missionTitle: null, amountCents: 18_000, status: 'paid', date: '2026-10-05' },
    ],
  };

  it('shows balances and recent payouts', () => {
    const embed = earningsEmbed('Pilot 5678', earnings, TODAY).toJSON();
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Pending).toBe('$870.00');
    expect(fields['Available for instant payout']).toBe('$610.00');
    expect(fields['Paid, year to date']).toBe('$735.00');
    expect(fields['Recent payouts']).toBe('🕓 Pending · $610.00 · Fri, Oct 9 · Ranch boundary survey\n✅ Paid · $180.00 · Mon, Oct 5');
    expect(embed.color).toBe(Colors.success);
  });

  it('turns red and explains when a payout failed', () => {
    const failed = { ...earnings, recentPayouts: [{ ...earnings.recentPayouts[0]!, status: 'failed' as const }] };
    const embed = earningsEmbed('Pilot 5678', failed, TODAY).toJSON();
    expect(embed.color).toBe(Colors.danger);
    expect(embed.description).toContain('payout failed');
  });
});

describe('/argus credentials formatting', () => {
  const credential = (overrides: Partial<CredentialSummary['credentials'][number]>) => ({
    kind: 'faa_part107' as const,
    status: 'approved' as const,
    expiresAt: '2028-06-10',
    insuranceMode: null,
    ...overrides,
  });

  it('describes each credential state', () => {
    expect(credentialLine(credential({}), TODAY)).toBe('🟢 **FAA Part 107**: approved, expires Sat, Jun 10, 2028');
    expect(credentialLine(credential({ kind: 'insurance', expiresAt: '2026-11-04', insuranceMode: 'annual' }), TODAY)).toBe(
      '🟡 **Liability insurance**: expires Wed, Nov 4 (in 25 days)',
    );
    expect(credentialLine(credential({ expiresAt: TODAY }), TODAY)).toContain('(today)');
    expect(credentialLine(credential({ expiresAt: '2026-10-01' }), TODAY)).toBe('🔴 **FAA Part 107**: expired Thu, Oct 1');
    expect(credentialLine(credential({ kind: 'id', expiresAt: null }), TODAY)).toBe('🟢 **Government ID**: approved');
    expect(credentialLine(credential({ status: 'pending' }), TODAY)).toBe('🕓 **FAA Part 107**: waiting for review');
    expect(credentialLine(credential({ status: 'missing' }), TODAY)).toBe('🔴 **FAA Part 107**: not uploaded');
    expect(credentialLine(credential({ kind: 'insurance', status: 'pending', insuranceMode: 'on_demand' }), TODAY)).toBe(
      '🕓 **Liability insurance** (on-demand, per flight): waiting for review',
    );
  });

  it('colors the embed by the worst credential and explains a pause', () => {
    const ok: CredentialSummary = { verificationStatus: 'verified', standingTier: 'trusted', paused: false, credentials: [credential({})] };
    expect(credentialsEmbed('P', ok, TODAY).toJSON().color).toBe(Colors.success);
    const soon = { ...ok, credentials: [credential({ expiresAt: '2026-10-20' })] };
    expect(credentialsEmbed('P', soon, TODAY).toJSON().color).toBe(Colors.warning);
    const paused = { ...ok, paused: true };
    const embed = credentialsEmbed('P', paused, TODAY).toJSON();
    expect(embed.color).toBe(Colors.danger);
    expect(embed.description).toContain('paused');
    expect(embed.footer?.text).toContain('never shown');
  });
});

describe('status formatting', () => {
  const degraded = {
    state: 'degraded' as const,
    summary: 'Uploads are slow.',
    components: [{ name: 'Deliverable uploads', state: 'degraded' as const }],
    updatedAt: '2026-10-10T12:00:00Z',
  };

  it('shows the state, summary, and components', () => {
    const embed = statusEmbed(degraded).toJSON();
    expect(embed.title).toBe('🟡 Argus: Degraded performance');
    expect(embed.description).toBe('Uploads are slow.');
    expect(embed.fields?.[0]?.value).toBe('🟡 Deliverable uploads');
  });

  it('titles changes and recoveries', () => {
    expect(statusChangeEmbed('operational', degraded).toJSON().title).toBe('🟡 Argus status: Degraded performance (was all systems operational)');
    expect(statusChangeEmbed('outage', { ...degraded, state: 'operational', summary: null }).toJSON().title).toBe(
      '🟢 Argus recovered: all systems operational',
    );
  });
});

describe('help and account formatting', () => {
  const entries = [
    { id: 'a', question: 'Question A?', answer: 'Answer A.' },
    { id: 'b', question: 'Question B?', answer: 'Answer B.' },
  ];

  it('shows all answers, one answer, or a question list when the FAQ is long', () => {
    expect(faqEmbed(entries, true, 'https://x.test').toJSON().fields).toHaveLength(2);
    expect(faqEmbed([entries[0]!], true, 'https://x.test').toJSON()).toMatchObject({ title: 'Question A?', description: 'Answer A.' });
    expect(faqEmbed(entries, false, 'https://x.test').toJSON().footer?.text).toContain('https://x.test');
    const long = Array.from({ length: 6 }, (_, i) => ({ id: `q${i}`, question: `Q${i}?`, answer: 'x'.repeat(FAQ_INLINE_LIMIT / 5) }));
    const embed = faqEmbed(long, true, 'https://x.test').toJSON();
    expect(embed.fields).toBeUndefined();
    expect(embed.description).toContain('• Q5?');
  });

  it('mentions a Certa link in the link confirmation', () => {
    expect(linkConfirmation('Pilot 5678', 'pilot', null)).not.toContain('Certa');
    expect(linkConfirmation('Pilot 5678', 'pilot', 'Ava R.')).toContain("You're also linked to Certa as **Ava R.**, so log the flights");
    expect(linkConfirmation('Client 5678', 'client', 'Ava R.')).toContain("You're also linked to Certa as **Ava R.**.");
    expect(linkConfirmation('Client 5678', 'client', null)).toContain('/argus jobs');
  });

  it('preselects enabled alerts in the alerts panel', () => {
    const panel = alertsPanel('client', { ...DEFAULT_BOT_SETTINGS, disabledAlerts: ['job.step'] }, 'https://a.test/app');
    const menu = (panel.components?.[0] as { toJSON(): { components: { options: { value: string; default?: boolean }[] }[] } }).toJSON()
      .components[0]!;
    const defaults = Object.fromEntries(menu.options.map((o) => [o.value, o.default ?? false]));
    expect(defaults['job.step']).toBe(false);
    expect(defaults['job.status_changed']).toBe(true);
    expect(Object.keys(defaults)).not.toContain('payout.paid');
  });
});

describe('event formatting', () => {
  it('builds an embed for every event type, with an alerts footer on personal events', () => {
    for (const type of EVENT_TYPES) {
      const personal = formatEvent(sampleEvent(type, { userId: 'argus-1' }), TODAY).toJSON();
      expect(personal.title, type).toBeTruthy();
      if (type !== 'service.status_changed') expect(personal.footer?.text).toBe('Manage these DMs with /argus alerts');
      expect(formatEvent(sampleEvent(type), TODAY).toJSON().footer?.text).not.toBe('Manage these DMs with /argus alerts');
    }
  });

  it('formats key event details', () => {
    expect(formatEvent(sampleEvent('job.status_changed', { userId: 'a' }), TODAY).toJSON().description).toContain(
      '📅 Scheduled → **🛫 In progress**',
    );
    expect(formatEvent(sampleEvent('credential.expiring', { userId: 'a' }), TODAY).toJSON().title).toBe(
      '⏰ Liability insurance expires in 14 days',
    );
    expect(formatEvent(sampleEvent('payout.failed', { userId: 'a' }), TODAY).toJSON().color).toBe(Colors.danger);
  });
});
