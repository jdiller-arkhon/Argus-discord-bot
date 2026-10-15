import { describe, expect, it } from 'vitest';
import { missionIds } from '../src/commands/missions.js';
import { NOT_LINKED_MESSAGE, PILOT_ONLY_MESSAGE } from '../src/context.js';
import { button, command, select, setup, USER } from './fixtures.js';

async function linkAs(run: Awaited<ReturnType<typeof setup>>['run'], code: string, userId = USER) {
  return run(command('link', { code }, userId));
}

describe('/argus link and unlink', () => {
  it('links with a one-time code, stores the role, and notes a Certa link', async () => {
    const { run, context } = await setup({ certaName: 'Ava R.' });
    const reply = await linkAs(run, 'pilot-abc123');
    expect(reply.ephemeral).toBe(true);
    expect(reply.last.content).toContain('Linked to Argus as **Pilot 5678** (pilot account).');
    expect(reply.last.content).toContain("You're also linked to Certa as **Ava R.**");
    expect(await context.store.getLink(USER)).toMatchObject({ role: 'pilot', argusUserId: `mock-pilot-${USER}` });
  });

  it('rejects malformed and reused codes', async () => {
    const { run } = await setup();
    expect((await linkAs(run, 'no')).last.content).toContain('does not look like an Argus link code');
    await linkAs(run, 'CLIENT-1234');
    expect((await linkAs(run, 'client-1234')).last.content).toContain("That link code isn't valid");
  });

  it('unlinks after confirmation, on Argus too, and is idempotent', async () => {
    const { run, context, mock } = await setup();
    await linkAs(run, 'CLIENT-1234');
    const argusUserId = `mock-client-${USER}`;
    await mock.updateBotSettings(argusUserId, { ...(await mock.getBotSettings(argusUserId)), disabledAlerts: ['job.step'] });

    const ask = await run(command('unlink'));
    expect(ask.last.content).toContain('Unlink Discord from Argus?');
    expect(await context.store.getLink(USER)).toBeDefined();
    expect((await run(button('argus-account:cancel'))).last.content).toBe('Cancelled. You are still linked.');

    const done = await run(button('argus-account:unlink'));
    expect(done.last.content).toContain('no longer linked');
    expect(await context.store.getLink(USER)).toBeUndefined();
    // The mock's Argus side forgot the user's bot settings.
    expect((await mock.getBotSettings(argusUserId)).disabledAlerts).toEqual([]);
    expect((await run(command('unlink'))).last.content).toContain('nothing to remove');
  });

  it('drops a stale link when Argus no longer knows the account', async () => {
    const { run, context } = await setup();
    await context.store.upsertLink({ discordUserId: USER, argusUserId: 'mock-pilot-gone', displayName: 'Gone', role: 'pilot' });
    const reply = await run(command('earnings'));
    expect(reply.last.content).toContain('Your Discord link was removed on Argus');
    expect(await context.store.getLink(USER)).toBeUndefined();
  });
});

describe('account commands before linking', () => {
  it('reply with the not-linked message', async () => {
    const { run } = await setup();
    for (const sub of ['jobs', 'missions', 'earnings', 'credentials', 'alerts']) {
      const reply = await run(command(sub));
      expect(reply.ephemeral, sub).toBe(true);
      expect(reply.last.content, sub).toBe(NOT_LINKED_MESSAGE);
    }
    expect((await run(command('job', { id: 1 }))).last.content).toBe(NOT_LINKED_MESSAGE);
  });
});

describe('client commands', () => {
  it('lists active jobs and shows one in detail with live progress', async () => {
    const { run } = await setup();
    await linkAs(run, 'CLIENT-1234');
    const jobs = await run(command('jobs'));
    expect(jobs.lastEmbed?.title).toBe('Active Argus jobs: Client 5678');
    expect(jobs.lastEmbed?.description).toContain('Roof inspection: 1420 Pine St');
    expect(jobs.lastEmbed?.description).toContain('🛫 In progress · In flight');
    expect(jobs.lastEmbed?.description).toContain('🔎 Finding a pilot');
    expect(jobs.lastEmbed?.description).not.toContain('Storefront promo flyover');

    const recent = await run(command('jobs', { scope: 'recent' }));
    expect(recent.lastEmbed?.description).toContain('Storefront promo flyover');

    const id = Number(/#(\d+) · Listing photos/.exec(jobs.lastEmbed!.description!)![1]);
    const job = await run(command('job', { id }));
    const fields = Object.fromEntries((job.lastEmbed?.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Deliverables (2)']).toContain('Walkthrough flyover');
    expect(fields['Next step']).toContain('approve');
  });

  it("does not show other users' jobs", async () => {
    const { run } = await setup();
    await linkAs(run, 'CLIENT-1234');
    await linkAs(run, 'CLIENT-9999', '999999999999999999');
    const reply = await run(command('job', { id: 6 }));
    expect(reply.last.content).toBe("Argus couldn't find that, or it isn't on your account.");
  });

  it('keeps pilot commands to pilots', async () => {
    const { run } = await setup();
    await linkAs(run, 'CLIENT-1234');
    for (const sub of ['missions', 'earnings', 'credentials']) {
      expect((await run(command(sub))).last.content).toBe(PILOT_ONLY_MESSAGE);
    }
  });
});

describe('pilot commands', () => {
  it('shows earnings and credentials', async () => {
    const { run } = await setup();
    await linkAs(run, 'PILOT-1234');
    const earnings = await run(command('earnings'));
    const fields = Object.fromEntries((earnings.lastEmbed?.fields ?? []).map((f) => [f.name, f.value]));
    // $260 awaiting approval + $610 pending payout.
    expect(fields.Pending).toBe('$870.00');
    expect(fields['Available for instant payout']).toBe('$610.00');
    expect(fields['Paid, last 30 days']).toBe('$525.00');

    const credentials = await run(command('credentials'));
    expect(credentials.lastEmbed?.fields?.find((f) => f.name === 'Documents')?.value).toContain(
      '🟡 **Liability insurance**: expires Wed, Nov 4 (in 25 days)',
    );
  });

  it('accepts a mission only after an explicit confirmation', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    const board = await run(command('missions'));
    expect(board.lastEmbed?.title).toBe('Open Argus missions');
    const menu = board.lastComponents[0]!;
    expect(menu.custom_id).toBe(missionIds.pick());
    const missionId = Number(menu.options![0]!.value);

    const picked = await run(select(missionIds.pick(), [String(missionId)]));
    expect(picked.lastEmbed?.title).toBe(`Accept mission #${missionId}?`);
    expect(picked.lastComponents.map((c) => c.custom_id)).toEqual([missionIds.confirm(missionId), missionIds.cancel()]);
    // Picking alone changes nothing.
    expect((await mock.listOpenMissions(`mock-pilot-${USER}`)).missions.map((m) => m.id)).toContain(missionId);

    const confirmed = await run(button(missionIds.confirm(missionId)));
    expect(confirmed.lastEmbed?.title).toContain('✅ Mission accepted');
    expect((await mock.listOpenMissions(`mock-pilot-${USER}`)).missions.map((m) => m.id)).not.toContain(missionId);
    const jobs = await run(command('jobs'));
    expect(jobs.lastEmbed?.description).toContain('Listing photos: 4-bed home');
  });

  it('cancels without changing anything, and reports a mission taken by someone else', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    await linkAs(run, 'PILOT-9999', '999999999999999999');
    const board = await run(command('missions'));
    const missionId = Number(board.lastComponents[0]!.options![0]!.value);

    expect((await run(button(missionIds.cancel()))).last.content).toBe('Cancelled. Nothing was changed in Argus.');

    await mock.acceptMission('mock-pilot-999999999999999999', missionId);
    const taken = await run(button(missionIds.confirm(missionId)));
    expect(taken.last.content).toBe('Another pilot accepted this mission first.');
    const repick = await run(select(missionIds.pick(), [String(missionId)]));
    expect(repick.last.content).toBe(`Mission #${missionId} is no longer open. Here is the current board.`);
  });

  it('hides the accept menu while the pilot is not verified', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    await mock.setPilotVerification(`mock-pilot-${USER}`, 'pending');
    const board = await run(command('missions'));
    expect(board.lastComponents).toEqual([]);
    expect(board.lastEmbed?.description).toContain("can't accept missions");
  });
});

describe('/argus alerts', () => {
  it('previews a selection and only saves it to Argus after Save', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'CLIENT-1234');
    const argusUserId = `mock-client-${USER}`;
    const panel = await run(command('alerts'));
    expect(panel.ephemeral).toBe(true);
    const options = panel.lastComponents[0]!.options!.map((o) => o.value);
    expect(options).toContain('job.deliverables_ready');
    expect(options).not.toContain('payout.paid');

    const preview = await run(select('argus-alerts:pick', ['job.status_changed']));
    expect(preview.lastEmbed?.description).toContain('Not saved yet');
    expect(preview.lastEmbed?.description).toContain('🔕 **Live job progress**');
    // Nothing changed on Argus yet.
    expect((await mock.getBotSettings(argusUserId)).disabledAlerts).toEqual([]);
    const save = preview.lastComponents.find((c) => c.custom_id?.startsWith('argus-alerts:save:'))!;

    const saved = await run(button(save.custom_id!));
    expect(saved.lastEmbed?.description).toContain('✅ Saved.');
    expect((await mock.getBotSettings(argusUserId)).disabledAlerts).toEqual(['job.step', 'job.deliverables_ready', 'dispute.updated']);
  });

  it('keeps quiet hours and mission filters set on the website when saving', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    const argusUserId = `mock-pilot-${USER}`;
    await mock.updateBotSettings(argusUserId, {
      disabledAlerts: [],
      timezone: 'America/Denver',
      missionAlerts: { minPayoutCents: 20_000, maxDistanceMi: 30, serviceTypes: [] },
      quietHours: { enabled: true, start: '22:00', end: '06:30', allowUrgent: true },
      digest: { enabled: true, hour: 6, skipEmpty: true },
    });
    const panel = await run(command('alerts'));
    expect(panel.lastEmbed?.description).toContain('Mission alerts: only at least $200.00, within 30 mi.');
    expect(panel.lastEmbed?.description).toContain('Quiet hours: 22:00–06:30 (America/Denver).');
    expect(panel.lastEmbed?.description).toContain('https://arkhonindustries.com/app/pilot/discord');

    const preview = await run(select('argus-alerts:pick', ['mission.posted']));
    const save = preview.lastComponents.find((c) => c.custom_id?.startsWith('argus-alerts:save:'))!;
    await run(button(save.custom_id!));
    const stored = await mock.getBotSettings(argusUserId);
    expect(stored.missionAlerts).toEqual({ minPayoutCents: 20_000, maxDistanceMi: 30, serviceTypes: [] });
    expect(stored.digest.hour).toBe(6);
    expect(stored.quietHours.end).toBe('06:30');
    expect(stored.disabledAlerts).not.toContain('mission.posted');
    expect(stored.disabledAlerts).toContain('payout.paid');
  });

  it('cancels without saving', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    await run(select('argus-alerts:pick', []));
    const cancelled = await run(button('argus-alerts:cancel'));
    expect(cancelled.lastEmbed?.description).not.toContain('Not saved yet');
    expect((await mock.getBotSettings(`mock-pilot-${USER}`)).disabledAlerts).toEqual([]);
  });
});

describe('/argus status and help', () => {
  it('shows status publicly', async () => {
    const { run, mock } = await setup({ env: { ARGUS_STATUS_CHANNEL_ID: '600000000000000001' } });
    await mock.setServiceStatus('degraded', 'Uploads are slow.');
    const reply = await run(command('status'));
    expect(reply.ephemeral).toBe(false);
    expect(reply.lastEmbed?.title).toBe('🟡 Argus: Degraded performance');
    expect(reply.last.content).toBe('Live updates post in <#600000000000000001>.');
  });

  it('shows the FAQ with a support link when tickets are not configured', async () => {
    const { run, context } = await setup();
    const all = await run(command('help'));
    expect(all.lastEmbed?.fields).toHaveLength(context.faq.entries.length);
    expect(all.lastComponents[0]).toMatchObject({ url: 'https://arkhonindustries.com/contact' });

    const one = await run(command('help', { topic: 'payouts' }));
    expect(one.lastEmbed?.title).toBe('When do pilots get paid?');
  });

  it('offers the shared ticket flow button when tickets are configured', async () => {
    const { context } = await setup();
    const { createTicketFlow, TicketStore, silentLogger } = await import('@arkhon/shared');
    context.tickets = createTicketFlow({
      product: 'argus',
      productLabel: 'Argus',
      prefix: 'argus-ticket',
      store: new TicketStore(context.store.db),
      logger: silentLogger,
      supportChannelId: '700000000000000001',
      staffRoleId: '700000000000000002',
    });
    const { createInteractionRouter } = await import('@arkhon/shared');
    const { createCommands, createComponents } = await import('../src/commands/index.js');
    const route = createInteractionRouter({ commands: createCommands(context), components: createComponents(context), logger: silentLogger });
    const reply = command('help');
    await route(reply as never);
    expect(reply.lastComponents[0]).toMatchObject({ custom_id: 'argus-ticket:open' });

    // The ticket button needs a server; in a DM it explains instead of failing.
    const click = button('argus-ticket:open');
    await route(click as never);
    expect(click.last.content).toBe('Support tickets can only be opened from the server, not in DMs.');
  });
});

describe('pilot tools', () => {
  it('shows today, with duty, missions, payouts and documents', async () => {
    const { run } = await setup();
    await linkAs(run, 'PILOT-1234');
    const reply = await run(command('today'));
    const fields = Object.fromEntries((reply.lastEmbed?.fields ?? []).map((f) => [f.name, f.value]));
    expect(reply.lastEmbed?.title).toBe('Today on Argus');
    expect(fields["Today's jobs (1)"]).toContain('Solar array inspection');
    expect(fields.Duty).toContain('Off duty');
    expect(fields['Open missions']).toContain('best $610.00');
    expect(fields['Documents needing attention']).toContain('Liability insurance');
  });

  it('shows clients what is waiting on them', async () => {
    const { run } = await setup();
    await linkAs(run, 'CLIENT-1234');
    const fields = Object.fromEntries(((await run(command('today'))).lastEmbed?.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields['Waiting on you']).toContain('1 job ready for your review');
    expect(fields.Duty).toBeUndefined();
  });

  it('groups the schedule by day', async () => {
    const { run } = await setup();
    await linkAs(run, 'PILOT-1234');
    const names = ((await run(command('schedule'))).lastEmbed?.fields ?? []).map((f) => f.name);
    expect(names).toEqual(['Today · Sat, Oct 10', 'Tomorrow · Sun, Oct 11']);
  });

  it('posts a field step only after confirmation', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    const argusUserId = `mock-pilot-${USER}`;
    const jobId = (await mock.listJobs(argusUserId, 'active')).find((j) => j.title === 'Vineyard aerial photos')!.id;

    const ask = await run(command('step', { job: jobId, step: 'en_route' }));
    expect(ask.lastEmbed?.title).toBe(`Post "Pilot en route" on job #${jobId}?`);
    expect((await mock.getJob(argusUserId, jobId)).steps).toEqual([]);

    const done = await run(button(`argus-tools:step:${jobId}:en_route`));
    expect(done.lastEmbed?.title).toBe(`✅ Pilot en route · job #${jobId}`);
    const job = await mock.getJob(argusUserId, jobId);
    expect(job.status).toBe('in_progress');
    expect(job.steps.map((s) => s.step)).toEqual(['en_route']);

    const again = await run(button(`argus-tools:step:${jobId}:en_route`));
    expect(again.last.content).toBe('That step is already done. Progress only moves forward.');
  });

  it('changes duty only after confirmation, and refuses unverified pilots', async () => {
    const { run, mock } = await setup();
    await linkAs(run, 'PILOT-1234');
    const argusUserId = `mock-pilot-${USER}`;
    expect((await run(command('duty'))).lastEmbed?.title).toBe('⚪ You are off duty');

    const ask = await run(command('duty', { set: 'on' }));
    expect(ask.lastComponents.map((c) => c.custom_id)).toEqual(['argus-tools:duty:on', 'argus-tools:cancel']);
    expect(await mock.getDuty(argusUserId)).toBe(false);
    expect((await run(button('argus-tools:duty:on'))).lastEmbed?.title).toBe('🟢 You are on duty');
    expect(await mock.getDuty(argusUserId)).toBe(true);

    await mock.setPilotVerification(argusUserId, 'pending');
    await run(button('argus-tools:duty:off'));
    const refused = await run(button('argus-tools:duty:on'));
    expect(refused.last.content).toContain('credentials must be verified');
  });

  it('shows stats with reviews and the road to the next tier', async () => {
    const { run } = await setup();
    await linkAs(run, 'PILOT-1234');
    const embed = (await run(command('stats'))).lastEmbed!;
    const fields = Object.fromEntries((embed.fields ?? []).map((f) => [f.name, f.value]));
    expect(fields.Rating).toBe('4.67 ★★★★★ (3 reviews)');
    expect(fields['Road to Trusted']).toContain('▫️ Completed jobs: 1 / 25');
    expect(fields['Latest reviews']).toContain('Fast, careful');
  });

  it('keeps pilot tools to pilots', async () => {
    const { run } = await setup();
    await linkAs(run, 'CLIENT-1234');
    for (const sub of ['stats', 'duty']) expect((await run(command(sub))).last.content).toBe(PILOT_ONLY_MESSAGE);
    expect((await run(command('step', { job: 1, step: 'on_site' }))).last.content).toBe(PILOT_ONLY_MESSAGE);
  });
});
