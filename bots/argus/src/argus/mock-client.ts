import type { SqlDb, SqlValue } from '@arkhon/shared';
import { DateTime } from 'luxon';
import {
  type ArgusClient,
  ArgusInvalidLinkCodeError,
  ArgusNotFoundError,
  ArgusRejectedError,
  ArgusUserNotFoundError,
} from './client.js';
import {
  type AcceptMissionResult,
  type ArgusRole,
  type BotSettings,
  botSettingsSchema,
  DEFAULT_BOT_SETTINGS,
  type FieldStepResult,
  type PilotStats,
  type TodaySummary,
  type CredentialSummary,
  type Earnings,
  type JobDetail,
  type JobScope,
  type JobStatus,
  type JobStep,
  type JobSummary,
  JOB_STEPS,
  type LinkResult,
  type MissionBoard,
  type ServiceState,
  type ServiceStatus,
  serviceStatusSchema,
} from './types.js';

export interface MockArgusClientOptions {
  timezone: string;
  now?: () => DateTime;
}

interface UserRow {
  argus_user_id: string;
  display_name: string;
  role: ArgusRole;
  verification_status: CredentialSummary['verificationStatus'];
  standing_tier: CredentialSummary['standingTier'];
  paused: number;
  on_duty: number;
}

interface JobRow {
  id: number;
  client_user_id: string;
  client_name: string;
  pilot_user_id: string | null;
  pilot_name: string | null;
  title: string;
  service_type: string;
  locality: string;
  status: JobStatus;
  payment_status: JobSummary['paymentStatus'];
  scheduled_for: string | null;
  time_window: string | null;
  amount_cents: number;
  payout_cents: number;
  image_count: number;
  add_ons: string;
  created_at: string;
}

interface MissionRow {
  id: number;
  title: string;
  service_type: string;
  locality: string;
  distance_mi: number | null;
  payout_cents: number;
  amount_cents: number;
  scheduled_for: string | null;
  time_window: string | null;
  image_count: number;
  add_ons: string;
  status: 'open' | 'accepted';
  posted_at: string;
}

/** Mock service labels -> the platform's service ids (lib/platform/pricing.ts SERVICES). */
const MOCK_SERVICE_IDS: Record<string, string> = {
  'Real Estate Photography': 'realestate',
  'Roof Inspection': 'roof',
  'Construction Progress': 'construction',
  'Mapping & Orthomosaics': 'survey',
  'Aerial Photography': 'realestate',
};

const ACTIVE_STATUSES: JobStatus[] = ['awaiting_payment', 'pending', 'scheduled', 'in_progress', 'review', 'needs_review'];

/** Missions the mock board is refilled with whenever it runs empty. */
const MISSION_SEED = [
  { title: 'Listing photos: 4-bed home', service: 'Real Estate Photography', locality: 'Golden, CO', distance: 12.4, payout: 18_000, amount: 25_000, days: 2, window: 'morning', images: 25, addOns: [] },
  { title: 'Roof inspection after hail', service: 'Roof Inspection', locality: 'Littleton, CO', distance: 18.9, payout: 26_500, amount: 37_500, days: 3, window: 'midday', images: 40, addOns: ['report'] },
  { title: 'Construction progress, phase 2', service: 'Construction Progress', locality: 'Aurora, CO', distance: 22.1, payout: 31_000, amount: 44_500, days: 5, window: 'morning', images: 60, addOns: ['4kvideo'] },
  { title: '40-acre parcel orthomosaic', service: 'Mapping & Orthomosaics', locality: 'Fort Lupton, CO', distance: 34.7, payout: 61_000, amount: 89_500, days: 7, window: 'afternoon', images: 0, addOns: ['orthomosaic', '3dmodel'] },
] as const;

/**
 * ArgusClient backed by the bot's own database (`mock_*` tables), so every
 * command works before the Argus API ships. Any well-formed link code links
 * once. Codes starting with `CLIENT` link a client account, `ADMIN` an admin,
 * anything else a pilot. Each new account is seeded with realistic jobs (and,
 * for pilots, credentials and payouts) dated relative to today.
 */
export class MockArgusClient implements ArgusClient {
  private readonly now: () => DateTime;

  constructor(
    private readonly db: SqlDb,
    options: MockArgusClientOptions,
  ) {
    this.now = options.now ?? (() => DateTime.now().setZone(options.timezone));
  }

  async redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult> {
    const normalized = code.trim().toUpperCase();
    if (await this.db.get('SELECT 1 AS used FROM mock_redeemed_codes WHERE code = ?', normalized)) {
      throw new ArgusInvalidLinkCodeError('Link code has already been used');
    }
    const role: ArgusRole = normalized.startsWith('CLIENT') ? 'client' : normalized.startsWith('ADMIN') ? 'admin' : 'pilot';
    // Stable per Discord user and role, so unlinking and relinking keeps the seeded data.
    const argusUserId = `mock-${role}-${discordUserId}`;
    const now = this.now();

    const inserted = await this.db.run(
      `INSERT OR IGNORE INTO mock_users (argus_user_id, display_name, role, verification_status, standing_tier, paused, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      argusUserId,
      `${role === 'pilot' ? 'Pilot' : role === 'client' ? 'Client' : 'Admin'} ${discordUserId.slice(-4)}`,
      role,
      role === 'pilot' ? 'verified' : 'unverified',
      role === 'pilot' ? 'established' : null,
      now.toISO(),
    );
    if (inserted.changes > 0) await this.seedUser(argusUserId, role);
    // The code is the primary key, so a code redeemed twice at once fails here.
    await this.db.run(
      'INSERT INTO mock_redeemed_codes (code, argus_user_id, discord_user_id, redeemed_at) VALUES (?, ?, ?, ?)',
      normalized,
      argusUserId,
      discordUserId,
      now.toISO(),
    );

    const user = await this.requireUser(argusUserId);
    return { argusUserId, displayName: user.display_name, role: user.role };
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    const row = await this.db.get<{ state: ServiceState; summary: string | null; updated_at: string }>(
      'SELECT state, summary, updated_at FROM mock_service_status WHERE id = 1',
    );
    const status = row ?? { state: 'operational' as const, summary: null, updated_at: this.now().toISO()! };
    return serviceStatusSchema.parse({
      state: status.state,
      summary: status.summary,
      components: [
        { name: 'Quotes & booking', state: status.state === 'outage' ? 'outage' : 'operational' },
        { name: 'Pilot dispatch', state: status.state },
        { name: 'Deliverable uploads', state: status.state },
      ],
      updatedAt: status.updated_at,
    });
  }

  async listJobs(argusUserId: string, scope: JobScope): Promise<JobSummary[]> {
    await this.requireUser(argusUserId);
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const filter = scope === 'active' ? `status IN (${placeholders})` : `status NOT IN (${placeholders})`;
    const order = scope === 'active' ? 'scheduled_for IS NULL, scheduled_for ASC, id ASC' : 'scheduled_for DESC, id DESC';
    const rows = await this.db.all<JobRow>(
      `SELECT * FROM mock_jobs WHERE (client_user_id = ? OR pilot_user_id = ?) AND ${filter} ORDER BY ${order} LIMIT 10`,
      argusUserId,
      argusUserId,
      ...ACTIVE_STATUSES,
    );
    return Promise.all(rows.map((row) => this.toSummary(row, argusUserId)));
  }

  async getJob(argusUserId: string, jobId: number): Promise<JobDetail> {
    await this.requireUser(argusUserId);
    const row = await this.db.get<JobRow>(
      'SELECT * FROM mock_jobs WHERE id = ? AND (client_user_id = ? OR pilot_user_id = ?)',
      jobId,
      argusUserId,
      argusUserId,
    );
    if (!row) throw new ArgusNotFoundError(`Job ${jobId} not found`);

    const steps = await this.db.all<{ step: JobStep; at: string }>('SELECT step, at FROM mock_job_steps WHERE job_id = ?', jobId);
    steps.sort((a, b) => JOB_STEPS.indexOf(a.step) - JOB_STEPS.indexOf(b.step));
    const deliverables = await this.db.all<JobDetail['deliverables'][number]>(
      'SELECT name, kind, image_count AS imageCount FROM mock_deliverables WHERE job_id = ? ORDER BY id',
      jobId,
    );

    return {
      ...(await this.toSummary(row, argusUserId)),
      imageCount: row.image_count,
      addOns: JSON.parse(row.add_ons) as string[],
      steps,
      deliverables,
      createdAt: row.created_at,
    };
  }

  async listOpenMissions(argusUserId: string): Promise<MissionBoard> {
    const user = await this.requirePilot(argusUserId);
    const open = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM mock_missions WHERE status = 'open'`);
    if ((open?.n ?? 0) === 0) await this.seedMissions();

    const rows = await this.db.all<MissionRow>(
      `SELECT * FROM mock_missions WHERE status = 'open' ORDER BY scheduled_for ASC, id ASC LIMIT 25`,
    );
    return {
      canAccept: user.verification_status === 'verified' && user.paused === 0,
      tier: user.standing_tier,
      missions: rows.map((row) => ({
        id: row.id,
        title: row.title,
        serviceType: row.service_type,
        serviceId: MOCK_SERVICE_IDS[row.service_type] ?? null,
        locality: row.locality,
        distanceMi: row.distance_mi,
        payoutCents: row.payout_cents,
        scheduledFor: row.scheduled_for,
        timeWindow: row.time_window,
        imageCount: row.image_count,
        addOns: JSON.parse(row.add_ons) as string[],
        postedAt: row.posted_at,
      })),
    };
  }

  async acceptMission(argusUserId: string, missionId: number): Promise<AcceptMissionResult> {
    const user = await this.requirePilot(argusUserId);
    if (user.verification_status !== 'verified' || user.paused === 1) {
      throw new ArgusRejectedError('Pilot cannot accept missions', 'Your credentials must be verified and current before you can accept missions.');
    }
    const mission = await this.db.get<MissionRow>('SELECT * FROM mock_missions WHERE id = ?', missionId);
    if (!mission) throw new ArgusNotFoundError(`Mission ${missionId} not found`);

    // Atomic claim: only the first pilot to flip the row from open wins.
    const claimed = await this.db.run(
      `UPDATE mock_missions SET status = 'accepted', pilot_user_id = ? WHERE id = ? AND status = 'open'`,
      argusUserId,
      missionId,
    );
    if (claimed.changes === 0) {
      throw new ArgusRejectedError('Mission already taken', 'Another pilot accepted this mission first.');
    }
    const jobId = await this.insertJob({
      clientUserId: 'mock-client-marketplace',
      clientName: 'Arkhon client',
      pilotUserId: argusUserId,
      pilotName: user.display_name,
      title: mission.title,
      serviceType: mission.service_type,
      locality: mission.locality,
      status: 'scheduled',
      paymentStatus: 'paid',
      scheduledFor: mission.scheduled_for,
      timeWindow: mission.time_window,
      amountCents: mission.amount_cents,
      payoutCents: mission.payout_cents,
      imageCount: mission.image_count,
      addOns: JSON.parse(mission.add_ons) as string[],
    });
    await this.db.run('UPDATE mock_missions SET job_id = ? WHERE id = ?', jobId, missionId);
    return { missionId, jobId, title: mission.title, scheduledFor: mission.scheduled_for };
  }

  async getEarnings(argusUserId: string): Promise<Earnings> {
    await this.requirePilot(argusUserId);
    const today = this.now().startOf('day');
    const total = async (sql: string, ...params: SqlValue[]) => (await this.db.get<{ total: number }>(sql, ...params))?.total ?? 0;
    const sum = (where: string, ...params: SqlValue[]) =>
      total(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM mock_payouts WHERE pilot_user_id = ? AND ${where}`, argusUserId, ...params);

    const awaitingApproval = await total(
      `SELECT COALESCE(SUM(payout_cents), 0) AS total FROM mock_jobs WHERE pilot_user_id = ? AND status = 'review'`,
      argusUserId,
    );
    const available = await sum(`status = 'pending'`);
    const completed = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM mock_jobs WHERE pilot_user_id = ? AND status = 'completed'`,
      argusUserId,
    );
    const recent = await this.db.all<Omit<Earnings['recentPayouts'][number], 'id'> & { id: number }>(
      `SELECT id, mission_title AS missionTitle, amount_cents AS amountCents, status, date
       FROM mock_payouts WHERE pilot_user_id = ? ORDER BY date DESC, id DESC LIMIT 5`,
      argusUserId,
    );

    return {
      pendingCents: awaitingApproval + available + (await sum(`status = 'in_transit'`)),
      availableCents: available,
      paidLast30DaysCents: await sum(`status = 'paid' AND date >= ?`, today.minus({ days: 30 }).toISODate()),
      paidYearToDateCents: await sum(`status = 'paid' AND date >= ?`, today.startOf('year').toISODate()),
      completedMissions: completed?.n ?? 0,
      recentPayouts: recent.map((payout) => ({ ...payout, id: `po_mock_${payout.id}` })),
    };
  }

  async getCredentials(argusUserId: string): Promise<CredentialSummary> {
    const user = await this.requirePilot(argusUserId);
    const rows = await this.db.all<CredentialSummary['credentials'][number]>(
      'SELECT kind, status, expires_at AS expiresAt, insurance_mode AS insuranceMode FROM mock_credentials WHERE pilot_user_id = ?',
      argusUserId,
    );
    return {
      verificationStatus: user.verification_status,
      standingTier: user.standing_tier,
      paused: user.paused === 1,
      credentials: rows,
    };
  }

  async getToday(argusUserId: string): Promise<TodaySummary> {
    const user = await this.requireUser(argusUserId);
    const { timezone } = await this.getBotSettings(argusUserId);
    const now = this.now().setZone(timezone);
    const today = now.toISODate()!;
    const weekEnd = now.plus({ days: 7 }).toISODate()!;
    const active = await this.listJobs(argusUserId, 'active');
    let pilot: TodaySummary['pilot'] = null;
    if (user.role === 'pilot') {
      const board = await this.listOpenMissions(argusUserId);
      const money = await this.getEarnings(argusUserId);
      const creds = await this.getCredentials(argusUserId);
      const soon = now.plus({ days: 30 }).toISODate()!;
      pilot = {
        onDuty: user.on_duty === 1,
        canAccept: board.canAccept,
        openMissions: board.missions.length,
        bestPayoutCents: board.missions.reduce((best, m) => Math.max(best, m.payoutCents), 0),
        pendingPayoutCents: money.pendingCents,
        credentialAlerts: creds.credentials.filter((c) => c.status !== 'approved' || (c.expiresAt !== null && c.expiresAt <= soon)),
      };
    }
    return {
      date: today,
      timezone,
      todayJobs: active.filter((job) => job.scheduledFor === today),
      upcomingJobs: active.filter((job) => job.scheduledFor !== null && job.scheduledFor > today && job.scheduledFor <= weekEnd).length,
      awaitingReview: active.filter((job) => job.status === 'review' && job.viewerRole === 'client').length,
      pilot,
    };
  }

  async getStats(argusUserId: string): Promise<PilotStats> {
    const user = await this.requirePilot(argusUserId);
    const now = this.now();
    const count = async (status: string) =>
      (await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mock_jobs WHERE pilot_user_id = ? AND status = ?', argusUserId, status))
        ?.n ?? 0;
    const paidSince = async (from: string) =>
      (
        await this.db.get<{ total: number }>(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM mock_payouts WHERE pilot_user_id = ? AND status = 'paid' AND date >= ?`,
          argusUserId,
          from,
        )
      )?.total ?? 0;
    const reviews = await this.db.all<{ rating: number; body: string | null; date: string }>(
      'SELECT rating, body, date FROM mock_reviews WHERE pilot_user_id = ? ORDER BY date DESC, id DESC',
      argusUserId,
    );
    const rating = reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 100) / 100 : null;
    const completed = await count('completed');
    return {
      completedMissions: completed,
      activeMissions: (await count('scheduled')) + (await count('in_progress')),
      rating,
      reviewCount: reviews.length,
      earnedThisMonthCents: await paidSince(now.startOf('month').toISODate()!),
      earnedThisYearCents: await paidSince(now.startOf('year').toISODate()!),
      tier: user.standing_tier,
      paused: user.paused === 1,
      nextTier: {
        tier: 'trusted',
        requirements: [
          { label: 'Completed jobs', met: completed >= 25, have: String(completed), need: '25' },
          { label: 'Client reviews', met: reviews.length >= 10, have: String(reviews.length), need: '10' },
          { label: 'Rating, last 90 days', met: (rating ?? 0) >= 4.7, have: rating === null ? '—' : `${rating.toFixed(2)}★`, need: '4.7★' },
          { label: 'Credentials current', met: user.paused === 0, have: user.paused === 0 ? 'Current' : 'Expired', need: 'Current' },
        ],
      },
      recentReviews: reviews.slice(0, 3),
    };
  }

  async getDuty(argusUserId: string): Promise<boolean> {
    return (await this.requirePilot(argusUserId)).on_duty === 1;
  }

  async setDuty(argusUserId: string, onDuty: boolean): Promise<boolean> {
    const user = await this.requirePilot(argusUserId);
    if (onDuty && (user.verification_status !== 'verified' || user.paused === 1)) {
      throw new ArgusRejectedError('Cannot go on duty', 'Your credentials must be verified and current before you go on duty.');
    }
    await this.db.run('UPDATE mock_users SET on_duty = ? WHERE argus_user_id = ?', onDuty ? 1 : 0, argusUserId);
    return onDuty;
  }

  async postJobStep(argusUserId: string, jobId: number, step: JobStep, _note: string | null): Promise<FieldStepResult> {
    await this.requirePilot(argusUserId);
    const job = await this.db.get<{ status: JobStatus }>(
      'SELECT status FROM mock_jobs WHERE id = ? AND pilot_user_id = ?',
      jobId,
      argusUserId,
    );
    if (!job) throw new ArgusNotFoundError(`Job ${jobId} not found`);
    if (job.status !== 'scheduled' && job.status !== 'in_progress') {
      throw new ArgusRejectedError('Job not active', "This job isn't active, so its progress can't be updated.");
    }
    const done = (await this.db.all<{ step: JobStep }>('SELECT step FROM mock_job_steps WHERE job_id = ?', jobId)).map((r) => r.step);
    const furthest = Math.max(-1, ...done.map((s) => JOB_STEPS.indexOf(s)));
    if (JOB_STEPS.indexOf(step) <= furthest) {
      throw new ArgusRejectedError('Step already done', 'That step is already done. Progress only moves forward.');
    }
    const at = this.now().toISO()!;
    await this.db.batch([
      { sql: 'INSERT INTO mock_job_steps (job_id, step, at) VALUES (?, ?, ?)', params: [jobId, step, at] },
      { sql: `UPDATE mock_jobs SET status = 'in_progress' WHERE id = ? AND status = 'scheduled'`, params: [jobId] },
    ]);
    return { jobId, step, at: new Date(at).toISOString() };
  }

  async unlinkAccount(argusUserId: string): Promise<void> {
    await this.requireUser(argusUserId);
    await this.db.run('DELETE FROM mock_bot_settings WHERE argus_user_id = ?', argusUserId);
  }

  async getBotSettings(argusUserId: string): Promise<BotSettings> {
    await this.requireUser(argusUserId);
    const row = await this.db.get<{ settings_json: string }>(
      'SELECT settings_json FROM mock_bot_settings WHERE argus_user_id = ?',
      argusUserId,
    );
    if (!row) return DEFAULT_BOT_SETTINGS;
    const parsed = botSettingsSchema.safeParse(JSON.parse(row.settings_json));
    return parsed.success ? parsed.data : DEFAULT_BOT_SETTINGS;
  }

  async updateBotSettings(argusUserId: string, settings: BotSettings): Promise<BotSettings> {
    await this.requireUser(argusUserId);
    const parsed = botSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new ArgusRejectedError('Invalid settings', parsed.error.issues[0]?.message);
    await this.db.run(
      `INSERT INTO mock_bot_settings (argus_user_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (argus_user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      argusUserId,
      JSON.stringify(parsed.data),
      this.now().toISO(),
    );
    return parsed.data;
  }

  /** Dev helper (`pnpm argus:mock-status`): sets what getServiceStatus reports. */
  async setServiceStatus(state: ServiceState, summary: string | null = null): Promise<void> {
    await this.db.run(
      `INSERT INTO mock_service_status (id, state, summary, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET state = excluded.state, summary = excluded.summary, updated_at = excluded.updated_at`,
      state,
      summary,
      this.now().toISO(),
    );
  }

  /** Test/dev helper: changes a pilot's verification state. */
  async setPilotVerification(argusUserId: string, status: CredentialSummary['verificationStatus'], paused = false): Promise<void> {
    await this.requirePilot(argusUserId);
    await this.db.run(
      'UPDATE mock_users SET verification_status = ?, paused = ? WHERE argus_user_id = ?',
      status,
      paused ? 1 : 0,
      argusUserId,
    );
  }

  private async toSummary(row: JobRow, viewerId: string): Promise<JobSummary> {
    const viewerRole = row.pilot_user_id === viewerId ? 'pilot' : 'client';
    const latest = await this.db.all<{ step: JobStep }>('SELECT step FROM mock_job_steps WHERE job_id = ?', row.id);
    const latestStep = latest.map((s) => s.step).sort((a, b) => JOB_STEPS.indexOf(b) - JOB_STEPS.indexOf(a))[0] ?? null;
    return {
      id: row.id,
      title: row.title,
      serviceType: row.service_type,
      status: row.status,
      paymentStatus: row.payment_status,
      scheduledFor: row.scheduled_for,
      timeWindow: row.time_window,
      amountCents: viewerRole === 'pilot' ? row.payout_cents : row.amount_cents,
      locality: row.locality,
      viewerRole,
      counterpartName: viewerRole === 'pilot' ? row.client_name : row.pilot_name,
      latestStep,
    };
  }

  private async requireUser(argusUserId: string): Promise<UserRow> {
    const user = await this.db.get<UserRow>('SELECT * FROM mock_users WHERE argus_user_id = ?', argusUserId);
    if (!user) throw new ArgusUserNotFoundError(`Mock Argus user ${argusUserId} not found`);
    return user;
  }

  private async requirePilot(argusUserId: string): Promise<UserRow> {
    const user = await this.requireUser(argusUserId);
    if (user.role !== 'pilot') throw new ArgusRejectedError('Pilot only', 'This is only available to Argus pilot accounts.');
    return user;
  }

  private async insertJob(job: {
    clientUserId: string;
    clientName: string;
    pilotUserId: string | null;
    pilotName: string | null;
    title: string;
    serviceType: string;
    locality: string;
    status: JobStatus;
    paymentStatus: JobSummary['paymentStatus'];
    scheduledFor: string | null;
    timeWindow: string | null;
    amountCents: number;
    payoutCents: number;
    imageCount: number;
    addOns: readonly string[];
    createdAt?: string;
  }): Promise<number> {
    const result = await this.db.run(
      `INSERT INTO mock_jobs (client_user_id, client_name, pilot_user_id, pilot_name, title, service_type, locality, status,
         payment_status, scheduled_for, time_window, amount_cents, payout_cents, image_count, add_ons, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.clientUserId,
      job.clientName,
      job.pilotUserId,
      job.pilotName,
      job.title,
      job.serviceType,
      job.locality,
      job.status,
      job.paymentStatus,
      job.scheduledFor,
      job.timeWindow,
      job.amountCents,
      job.payoutCents,
      job.imageCount,
      JSON.stringify(job.addOns),
      job.createdAt ?? this.now().toISO(),
    );
    if (result.lastRowId === null) throw new Error('Mock job was not created');
    return result.lastRowId;
  }

  private async addSteps(jobId: number, steps: readonly JobStep[], start: DateTime): Promise<void> {
    await this.db.batch(
      steps.map((step, index) => ({
        sql: 'INSERT OR IGNORE INTO mock_job_steps (job_id, step, at) VALUES (?, ?, ?)',
        params: [jobId, step, start.plus({ minutes: index * 20 }).toISO()],
      })),
    );
  }

  private async insertAll(sql: string, rows: readonly (readonly SqlValue[])[]): Promise<void> {
    await this.db.batch(rows.map((params) => ({ sql, params })));
  }

  private async seedUser(argusUserId: string, role: ArgusRole): Promise<void> {
    const today = this.now().startOf('day');
    const date = (days: number) => today.plus({ days }).toISODate();
    const user = await this.requireUser(argusUserId);

    if (role === 'pilot') {
      const pilot = { pilotUserId: argusUserId, pilotName: user.display_name, clientName: 'Arkhon client' };
      const inProgress = await this.insertJob({
        ...pilot,
        clientUserId: 'mock-client-marketplace',
        title: 'Solar array inspection',
        serviceType: 'Roof Inspection',
        locality: 'Boulder, CO',
        status: 'in_progress',
        paymentStatus: 'paid',
        scheduledFor: date(0),
        timeWindow: 'morning',
        amountCents: 42_000,
        payoutCents: 29_500,
        imageCount: 45,
        addOns: ['report'],
      });
      await this.addSteps(inProgress, ['en_route', 'on_site', 'preflight'], this.now().minus({ hours: 1 }));
      await this.insertJob({
        ...pilot,
        clientUserId: 'mock-client-marketplace',
        title: 'Vineyard aerial photos',
        serviceType: 'Aerial Photography',
        locality: 'Palisade, CO',
        status: 'scheduled',
        paymentStatus: 'paid',
        scheduledFor: date(1),
        timeWindow: 'golden_hour',
        amountCents: 32_000,
        payoutCents: 22_500,
        imageCount: 30,
        addOns: ['4kvideo'],
      });
      const review = await this.insertJob({
        ...pilot,
        clientUserId: 'mock-client-marketplace',
        title: 'Retail lot progress shots',
        serviceType: 'Construction Progress',
        locality: 'Lakewood, CO',
        status: 'review',
        paymentStatus: 'paid',
        scheduledFor: date(-2),
        timeWindow: 'midday',
        amountCents: 38_000,
        payoutCents: 26_000,
        imageCount: 50,
        addOns: [],
      });
      await this.addSteps(review, JOB_STEPS, today.minus({ days: 2 }).set({ hour: 11 }));
      await this.insertJob({
        ...pilot,
        clientUserId: 'mock-client-marketplace',
        title: 'Ranch boundary survey',
        serviceType: 'Mapping & Orthomosaics',
        locality: 'Longmont, CO',
        status: 'completed',
        paymentStatus: 'paid',
        scheduledFor: date(-12),
        timeWindow: 'morning',
        amountCents: 89_500,
        payoutCents: 61_000,
        imageCount: 0,
        addOns: ['orthomosaic'],
      });

      await this.insertAll('INSERT INTO mock_payouts (pilot_user_id, mission_title, amount_cents, status, date) VALUES (?, ?, ?, ?, ?)', [
        [argusUserId, 'Ranch boundary survey', 61_000, 'pending', date(-1)],
        [argusUserId, 'Townhome listing photos', 18_000, 'paid', date(-5)],
        [argusUserId, 'Bridge deck inspection', 34_500, 'paid', date(-19)],
        [argusUserId, 'Event venue flyover', 21_000, 'paid', date(-40)],
      ]);
      await this.insertAll(
        'INSERT INTO mock_credentials (pilot_user_id, kind, status, expires_at, insurance_mode) VALUES (?, ?, ?, ?, ?)',
        [
          [argusUserId, 'faa_part107', 'approved', today.plus({ months: 20 }).toISODate(), null],
          // Inside the 30-day warning window so the expiry callout shows right away.
          [argusUserId, 'insurance', 'approved', date(25), 'annual'],
          [argusUserId, 'id', 'approved', null, null],
          [argusUserId, 'drone_reg', 'approved', today.plus({ months: 30 }).toISODate(), null],
        ],
      );
      await this.insertAll('INSERT INTO mock_reviews (pilot_user_id, rating, body, date) VALUES (?, ?, ?, ?)', [
        [argusUserId, 5, 'Fast, careful, and the map was exactly what our surveyor needed.', date(-10)],
        [argusUserId, 5, 'Great communication on site.', date(-18)],
        [argusUserId, 4, null, date(-41)],
      ]);
      return;
    }

    const client = { clientUserId: argusUserId, clientName: user.display_name };
    const inProgress = await this.insertJob({
      ...client,
      pilotUserId: 'mock-pilot-ava',
      pilotName: 'Ava R.',
      title: 'Roof inspection: 1420 Pine St',
      serviceType: 'Roof Inspection',
      locality: 'Boulder, CO',
      status: 'in_progress',
      paymentStatus: 'paid',
      scheduledFor: date(0),
      timeWindow: 'morning',
      amountCents: 37_500,
      payoutCents: 26_500,
      imageCount: 40,
      addOns: ['report'],
    });
    await this.addSteps(inProgress, ['en_route', 'on_site', 'preflight', 'airspace_cleared', 'in_flight'], this.now().minus({ hours: 2 }));
    const review = await this.insertJob({
      ...client,
      pilotUserId: 'mock-pilot-marcus',
      pilotName: 'Marcus T.',
      title: 'Listing photos: lake house',
      serviceType: 'Real Estate Photography',
      locality: 'Evergreen, CO',
      status: 'review',
      paymentStatus: 'paid',
      scheduledFor: date(-3),
      timeWindow: 'golden_hour',
      amountCents: 29_500,
      payoutCents: 20_500,
      imageCount: 25,
      addOns: ['4kvideo'],
    });
    await this.addSteps(review, JOB_STEPS, today.minus({ days: 3 }).set({ hour: 17 }));
    await this.insertAll('INSERT INTO mock_deliverables (job_id, name, kind, image_count) VALUES (?, ?, ?, ?)', [
      [review, 'Edited stills (zip)', 'image', 25],
      [review, 'Walkthrough flyover', 'video', 0],
    ]);
    await this.insertJob({
      ...client,
      pilotUserId: null,
      pilotName: null,
      title: 'Warehouse site map',
      serviceType: 'Mapping & Orthomosaics',
      locality: 'Commerce City, CO',
      status: 'pending',
      paymentStatus: 'paid',
      scheduledFor: date(4),
      timeWindow: 'midday',
      amountCents: 74_500,
      payoutCents: 52_000,
      imageCount: 0,
      addOns: ['orthomosaic'],
    });
    await this.insertJob({
      ...client,
      pilotUserId: 'mock-pilot-ava',
      pilotName: 'Ava R.',
      title: 'Storefront promo flyover',
      serviceType: 'Aerial Photography',
      locality: 'Denver, CO',
      status: 'completed',
      paymentStatus: 'paid',
      scheduledFor: date(-21),
      timeWindow: 'afternoon',
      amountCents: 24_500,
      payoutCents: 17_000,
      imageCount: 20,
      addOns: [],
    });
  }

  private async seedMissions(): Promise<void> {
    const today = this.now().startOf('day');
    await this.insertAll(
      `INSERT INTO mock_missions (title, service_type, locality, distance_mi, payout_cents, amount_cents, scheduled_for,
         time_window, image_count, add_ons, status, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      MISSION_SEED.map((m) => [
        m.title,
        m.service,
        m.locality,
        m.distance,
        m.payout,
        m.amount,
        today.plus({ days: m.days }).toISODate(),
        m.window,
        m.images,
        JSON.stringify(m.addOns),
        this.now().toISO(),
      ]),
    );
  }
}
