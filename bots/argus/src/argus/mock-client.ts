import type { Db } from '@arkhon/shared';
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

const ACTIVE_STATUSES: JobStatus[] = ['awaiting_payment', 'pending', 'scheduled', 'in_progress', 'review', 'needs_review'];

/** Missions the mock board is refilled with whenever it runs empty. */
const MISSION_SEED = [
  { title: 'Listing photos: 4-bed home', service: 'Real Estate Photography', locality: 'Golden, CO', distance: 12.4, payout: 18_000, amount: 25_000, days: 2, window: 'morning', images: 25, addOns: [] },
  { title: 'Roof inspection after hail', service: 'Roof Inspection', locality: 'Littleton, CO', distance: 18.9, payout: 26_500, amount: 37_500, days: 3, window: 'midday', images: 40, addOns: ['report'] },
  { title: 'Construction progress, phase 2', service: 'Construction Progress', locality: 'Aurora, CO', distance: 22.1, payout: 31_000, amount: 44_500, days: 5, window: 'morning', images: 60, addOns: ['4kvideo'] },
  { title: '40-acre parcel orthomosaic', service: 'Mapping & Orthomosaics', locality: 'Fort Lupton, CO', distance: 34.7, payout: 61_000, amount: 89_500, days: 7, window: 'afternoon', images: 0, addOns: ['orthomosaic', '3dmodel'] },
] as const;

/**
 * ArgusClient backed by the bot's local SQLite database (`mock_*` tables), so
 * every command works before the Argus API ships. Any well-formed link code
 * links once. Codes starting with `CLIENT` link a client account, `ADMIN` an
 * admin, anything else a pilot. Each new account is seeded with realistic
 * jobs (and, for pilots, credentials and payouts) dated relative to today.
 */
export class MockArgusClient implements ArgusClient {
  private readonly now: () => DateTime;

  constructor(
    private readonly db: Db,
    options: MockArgusClientOptions,
  ) {
    this.now = options.now ?? (() => DateTime.now().setZone(options.timezone));
  }

  async redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult> {
    const normalized = code.trim().toUpperCase();
    if (this.db.prepare('SELECT 1 FROM mock_redeemed_codes WHERE code = ?').get(normalized)) {
      throw new ArgusInvalidLinkCodeError('Link code has already been used');
    }
    const role: ArgusRole = normalized.startsWith('CLIENT') ? 'client' : normalized.startsWith('ADMIN') ? 'admin' : 'pilot';
    // Stable per Discord user and role, so unlinking and relinking keeps the seeded data.
    const argusUserId = `mock-${role}-${discordUserId}`;
    const now = this.now();

    this.db.transaction(() => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO mock_users (argus_user_id, display_name, role, verification_status, standing_tier, paused, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(
          argusUserId,
          `${role === 'pilot' ? 'Pilot' : role === 'client' ? 'Client' : 'Admin'} ${discordUserId.slice(-4)}`,
          role,
          role === 'pilot' ? 'verified' : 'unverified',
          role === 'pilot' ? 'established' : null,
          now.toISO(),
        );
      if (inserted.changes > 0) this.seedUser(argusUserId, role);
      this.db
        .prepare('INSERT INTO mock_redeemed_codes (code, argus_user_id, discord_user_id, redeemed_at) VALUES (?, ?, ?, ?)')
        .run(normalized, argusUserId, discordUserId, now.toISO());
    })();

    const user = this.requireUser(argusUserId);
    return { argusUserId, displayName: user.display_name, role: user.role };
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    const row = this.db.prepare('SELECT state, summary, updated_at FROM mock_service_status WHERE id = 1').get() as
      | { state: ServiceState; summary: string | null; updated_at: string }
      | undefined;
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
    this.requireUser(argusUserId);
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    const filter = scope === 'active' ? `status IN (${placeholders})` : `status NOT IN (${placeholders})`;
    const order = scope === 'active' ? 'scheduled_for IS NULL, scheduled_for ASC, id ASC' : 'scheduled_for DESC, id DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM mock_jobs WHERE (client_user_id = ? OR pilot_user_id = ?) AND ${filter} ORDER BY ${order} LIMIT 10`,
      )
      .all(argusUserId, argusUserId, ...ACTIVE_STATUSES) as JobRow[];
    return rows.map((row) => this.toSummary(row, argusUserId));
  }

  async getJob(argusUserId: string, jobId: number): Promise<JobDetail> {
    this.requireUser(argusUserId);
    const row = this.db
      .prepare('SELECT * FROM mock_jobs WHERE id = ? AND (client_user_id = ? OR pilot_user_id = ?)')
      .get(jobId, argusUserId, argusUserId) as JobRow | undefined;
    if (!row) throw new ArgusNotFoundError(`Job ${jobId} not found`);

    const steps = this.db.prepare('SELECT step, at FROM mock_job_steps WHERE job_id = ?').all(jobId) as { step: JobStep; at: string }[];
    steps.sort((a, b) => JOB_STEPS.indexOf(a.step) - JOB_STEPS.indexOf(b.step));
    const deliverables = this.db
      .prepare('SELECT name, kind, image_count AS imageCount FROM mock_deliverables WHERE job_id = ? ORDER BY id')
      .all(jobId) as JobDetail['deliverables'];

    return {
      ...this.toSummary(row, argusUserId),
      imageCount: row.image_count,
      addOns: JSON.parse(row.add_ons) as string[],
      steps,
      deliverables,
      createdAt: row.created_at,
    };
  }

  async listOpenMissions(argusUserId: string): Promise<MissionBoard> {
    const user = this.requirePilot(argusUserId);
    const open = this.db.prepare(`SELECT COUNT(*) AS n FROM mock_missions WHERE status = 'open'`).get() as { n: number };
    if (open.n === 0) this.seedMissions();

    const rows = this.db
      .prepare(`SELECT * FROM mock_missions WHERE status = 'open' ORDER BY scheduled_for ASC, id ASC LIMIT 25`)
      .all() as MissionRow[];
    return {
      canAccept: user.verification_status === 'verified' && user.paused === 0,
      tier: user.standing_tier,
      missions: rows.map((row) => ({
        id: row.id,
        title: row.title,
        serviceType: row.service_type,
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
    const user = this.requirePilot(argusUserId);
    if (user.verification_status !== 'verified' || user.paused === 1) {
      throw new ArgusRejectedError('Pilot cannot accept missions', 'Your credentials must be verified and current before you can accept missions.');
    }
    const mission = this.db.prepare('SELECT * FROM mock_missions WHERE id = ?').get(missionId) as MissionRow | undefined;
    if (!mission) throw new ArgusNotFoundError(`Mission ${missionId} not found`);

    return this.db.transaction(() => {
      // Atomic claim: only the first pilot to flip the row from open wins.
      const claimed = this.db
        .prepare(`UPDATE mock_missions SET status = 'accepted', pilot_user_id = ? WHERE id = ? AND status = 'open'`)
        .run(argusUserId, missionId);
      if (claimed.changes === 0) {
        throw new ArgusRejectedError('Mission already taken', 'Another pilot accepted this mission first.');
      }
      const jobId = this.insertJob({
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
      this.db.prepare('UPDATE mock_missions SET job_id = ? WHERE id = ?').run(jobId, missionId);
      return { missionId, jobId, title: mission.title, scheduledFor: mission.scheduled_for };
    })();
  }

  async getEarnings(argusUserId: string): Promise<Earnings> {
    this.requirePilot(argusUserId);
    const today = this.now().startOf('day');
    const sum = (where: string, ...params: unknown[]) =>
      (
        this.db
          .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM mock_payouts WHERE pilot_user_id = ? AND ${where}`)
          .get(argusUserId, ...params) as { total: number }
      ).total;

    const awaitingApproval = (
      this.db
        .prepare(`SELECT COALESCE(SUM(payout_cents), 0) AS total FROM mock_jobs WHERE pilot_user_id = ? AND status = 'review'`)
        .get(argusUserId) as { total: number }
    ).total;
    const available = sum(`status = 'pending'`);
    const completed = this.db
      .prepare(`SELECT COUNT(*) AS n FROM mock_jobs WHERE pilot_user_id = ? AND status = 'completed'`)
      .get(argusUserId) as { n: number };
    const recent = this.db
      .prepare(
        `SELECT id, mission_title AS missionTitle, amount_cents AS amountCents, status, date
         FROM mock_payouts WHERE pilot_user_id = ? ORDER BY date DESC, id DESC LIMIT 5`,
      )
      .all(argusUserId) as (Omit<Earnings['recentPayouts'][number], 'id'> & { id: number })[];

    return {
      pendingCents: awaitingApproval + available + sum(`status = 'in_transit'`),
      availableCents: available,
      paidLast30DaysCents: sum(`status = 'paid' AND date >= ?`, today.minus({ days: 30 }).toISODate()),
      paidYearToDateCents: sum(`status = 'paid' AND date >= ?`, today.startOf('year').toISODate()),
      completedMissions: completed.n,
      recentPayouts: recent.map((payout) => ({ ...payout, id: `po_mock_${payout.id}` })),
    };
  }

  async getCredentials(argusUserId: string): Promise<CredentialSummary> {
    const user = this.requirePilot(argusUserId);
    const rows = this.db
      .prepare('SELECT kind, status, expires_at AS expiresAt, insurance_mode AS insuranceMode FROM mock_credentials WHERE pilot_user_id = ?')
      .all(argusUserId) as CredentialSummary['credentials'];
    return {
      verificationStatus: user.verification_status,
      standingTier: user.standing_tier,
      paused: user.paused === 1,
      credentials: rows,
    };
  }

  /** Dev helper (`pnpm argus:mock-status`): sets what getServiceStatus reports. */
  setServiceStatus(state: ServiceState, summary: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO mock_service_status (id, state, summary, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, summary = excluded.summary, updated_at = excluded.updated_at`,
      )
      .run(state, summary, this.now().toISO());
  }

  /** Test/dev helper: changes a pilot's verification state. */
  setPilotVerification(argusUserId: string, status: CredentialSummary['verificationStatus'], paused = false): void {
    this.requirePilot(argusUserId);
    this.db
      .prepare('UPDATE mock_users SET verification_status = ?, paused = ? WHERE argus_user_id = ?')
      .run(status, paused ? 1 : 0, argusUserId);
  }

  private toSummary(row: JobRow, viewerId: string): JobSummary {
    const viewerRole = row.pilot_user_id === viewerId ? 'pilot' : 'client';
    const latest = this.db.prepare('SELECT step FROM mock_job_steps WHERE job_id = ?').all(row.id) as { step: JobStep }[];
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

  private requireUser(argusUserId: string): UserRow {
    const user = this.db.prepare('SELECT * FROM mock_users WHERE argus_user_id = ?').get(argusUserId) as UserRow | undefined;
    if (!user) throw new ArgusUserNotFoundError(`Mock Argus user ${argusUserId} not found`);
    return user;
  }

  private requirePilot(argusUserId: string): UserRow {
    const user = this.requireUser(argusUserId);
    if (user.role !== 'pilot') throw new ArgusRejectedError('Pilot only', 'This is only available to Argus pilot accounts.');
    return user;
  }

  private insertJob(job: {
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
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO mock_jobs (client_user_id, client_name, pilot_user_id, pilot_name, title, service_type, locality, status,
           payment_status, scheduled_for, time_window, amount_cents, payout_cents, image_count, add_ons, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    return Number(result.lastInsertRowid);
  }

  private addSteps(jobId: number, steps: readonly JobStep[], start: DateTime): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO mock_job_steps (job_id, step, at) VALUES (?, ?, ?)');
    steps.forEach((step, index) => insert.run(jobId, step, start.plus({ minutes: index * 20 }).toISO()));
  }

  private seedUser(argusUserId: string, role: ArgusRole): void {
    const today = this.now().startOf('day');
    const date = (days: number) => today.plus({ days }).toISODate();
    const user = this.requireUser(argusUserId);

    if (role === 'pilot') {
      const pilot = { pilotUserId: argusUserId, pilotName: user.display_name, clientName: 'Arkhon client' };
      const inProgress = this.insertJob({
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
      this.addSteps(inProgress, ['en_route', 'on_site', 'preflight'], this.now().minus({ hours: 1 }));
      this.insertJob({
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
      const review = this.insertJob({
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
      this.addSteps(review, JOB_STEPS, today.minus({ days: 2 }).set({ hour: 11 }));
      this.insertJob({
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

      const payout = this.db.prepare(
        'INSERT INTO mock_payouts (pilot_user_id, mission_title, amount_cents, status, date) VALUES (?, ?, ?, ?, ?)',
      );
      payout.run(argusUserId, 'Ranch boundary survey', 61_000, 'pending', date(-1));
      payout.run(argusUserId, 'Townhome listing photos', 18_000, 'paid', date(-5));
      payout.run(argusUserId, 'Bridge deck inspection', 34_500, 'paid', date(-19));
      payout.run(argusUserId, 'Event venue flyover', 21_000, 'paid', date(-40));

      const credential = this.db.prepare(
        'INSERT INTO mock_credentials (pilot_user_id, kind, status, expires_at, insurance_mode) VALUES (?, ?, ?, ?, ?)',
      );
      credential.run(argusUserId, 'faa_part107', 'approved', today.plus({ months: 20 }).toISODate(), null);
      // Inside the 30-day warning window so the expiry callout shows right away.
      credential.run(argusUserId, 'insurance', 'approved', date(25), 'annual');
      credential.run(argusUserId, 'id', 'approved', null, null);
      credential.run(argusUserId, 'drone_reg', 'approved', today.plus({ months: 30 }).toISODate(), null);
      return;
    }

    const client = { clientUserId: argusUserId, clientName: user.display_name };
    const inProgress = this.insertJob({
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
    this.addSteps(inProgress, ['en_route', 'on_site', 'preflight', 'airspace_cleared', 'in_flight'], this.now().minus({ hours: 2 }));
    const review = this.insertJob({
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
    this.addSteps(review, JOB_STEPS, today.minus({ days: 3 }).set({ hour: 17 }));
    const deliverable = this.db.prepare('INSERT INTO mock_deliverables (job_id, name, kind, image_count) VALUES (?, ?, ?, ?)');
    deliverable.run(review, 'Edited stills (zip)', 'image', 25);
    deliverable.run(review, 'Walkthrough flyover', 'video', 0);
    this.insertJob({
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
    this.insertJob({
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

  private seedMissions(): void {
    const today = this.now().startOf('day');
    const insert = this.db.prepare(
      `INSERT INTO mock_missions (title, service_type, locality, distance_mi, payout_cents, amount_cents, scheduled_for,
         time_window, image_count, add_ons, status, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    );
    for (const m of MISSION_SEED) {
      insert.run(
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
      );
    }
  }
}
