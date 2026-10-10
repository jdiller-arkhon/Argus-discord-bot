import { z } from 'zod';

// Response schemas use zod's default "strip" behaviour: unknown keys (for
// example an exact street address or a certificate number added by the
// backend later) are dropped and never reach the bot's storage or Discord.

/** `YYYY-MM-DD` calendar date. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const cents = z.number().int();
const id = z.number().int().positive();

export const ARGUS_ROLES = ['client', 'pilot', 'admin'] as const;
export const argusRoleSchema = z.enum(ARGUS_ROLES);
export type ArgusRole = z.infer<typeof argusRoleSchema>;

export const linkResultSchema = z.object({
  argusUserId: z.string().min(1),
  displayName: z.string().min(1),
  role: argusRoleSchema,
});
export type LinkResult = z.infer<typeof linkResultSchema>;

// ---------------------------------------------------------------- service status

export const SERVICE_STATES = ['operational', 'maintenance', 'degraded', 'outage'] as const;
export const serviceStateSchema = z.enum(SERVICE_STATES);
export type ServiceState = z.infer<typeof serviceStateSchema>;

export const serviceStatusSchema = z.object({
  state: serviceStateSchema,
  /** Short human-readable explanation, e.g. "Deliverable uploads are slow". */
  summary: z.string().max(500).nullable().default(null),
  components: z
    .array(z.object({ name: z.string().min(1).max(100), state: serviceStateSchema }))
    .max(20)
    .default([]),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/** Body of the platform's existing public `GET /api/health` probe. */
export const healthResponseSchema = z.object({ ok: z.boolean(), db: z.string().optional() });

// ---------------------------------------------------------------- jobs

/** Mirrors `projects.status` on the Argus platform. */
export const JOB_STATUSES = [
  'awaiting_payment',
  'pending',
  'scheduled',
  'in_progress',
  'review',
  'completed',
  'cancelled',
  'needs_review',
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded', 'disputed'] as const;
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

/** Mirrors `job_status_updates.step`: the pilot's live progress on site, in order. */
export const JOB_STEPS = ['en_route', 'on_site', 'preflight', 'airspace_cleared', 'in_flight', 'landed', 'uploading'] as const;
export const jobStepSchema = z.enum(JOB_STEPS);
export type JobStep = z.infer<typeof jobStepSchema>;

export const DELIVERABLE_KINDS = ['image', 'video', 'map', 'report'] as const;

export const jobScopeSchema = z.enum(['active', 'recent']);
export type JobScope = z.infer<typeof jobScopeSchema>;

export const jobSummarySchema = z.object({
  id,
  title: z.string().min(1).max(200),
  serviceType: z.string().min(1).max(100),
  status: jobStatusSchema,
  paymentStatus: paymentStatusSchema,
  /** Requested flight date. */
  scheduledFor: isoDate.nullable(),
  /** Time window id, e.g. `morning`. */
  timeWindow: z.string().max(50).nullable(),
  /** Job price for a client; payout for a pilot. */
  amountCents: cents.nonnegative(),
  /** City and state only. The bot never receives or shows exact addresses. */
  locality: z.string().max(100),
  /** How the linked user relates to this job. */
  viewerRole: z.enum(['client', 'pilot']),
  /** The pilot (for a client) or the client (for a pilot), if assigned. */
  counterpartName: z.string().max(100).nullable(),
  latestStep: jobStepSchema.nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const jobListSchema = z.object({ jobs: z.array(jobSummarySchema) });

export const jobDetailSchema = jobSummarySchema.extend({
  imageCount: z.number().int().nonnegative(),
  addOns: z.array(z.string().max(50)).default([]),
  steps: z.array(z.object({ step: jobStepSchema, at: z.string().datetime({ offset: true }) })),
  deliverables: z.array(
    z.object({
      name: z.string().min(1).max(200),
      kind: z.enum(DELIVERABLE_KINDS),
      imageCount: z.number().int().nonnegative(),
    }),
  ),
  createdAt: z.string().datetime({ offset: true }),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

// ---------------------------------------------------------------- missions

export const STANDING_TIERS = ['verified', 'established', 'trusted', 'elite'] as const;
export const standingTierSchema = z.enum(STANDING_TIERS);
export type StandingTier = z.infer<typeof standingTierSchema>;

export const openMissionSchema = z.object({
  id,
  title: z.string().min(1).max(200),
  serviceType: z.string().min(1).max(100),
  locality: z.string().max(100),
  /** Distance from the pilot's service area, when known. */
  distanceMi: z.number().nonnegative().nullable(),
  payoutCents: cents.nonnegative(),
  scheduledFor: isoDate.nullable(),
  timeWindow: z.string().max(50).nullable(),
  imageCount: z.number().int().nonnegative(),
  addOns: z.array(z.string().max(50)).default([]),
  postedAt: z.string().datetime({ offset: true }),
});
export type OpenMission = z.infer<typeof openMissionSchema>;

export const missionBoardSchema = z.object({
  /** False when the pilot cannot accept jobs yet (credentials not verified, or paused). */
  canAccept: z.boolean(),
  tier: standingTierSchema.nullable(),
  missions: z.array(openMissionSchema),
});
export type MissionBoard = z.infer<typeof missionBoardSchema>;

export const acceptMissionResultSchema = z.object({
  missionId: id,
  jobId: id,
  title: z.string().min(1).max(200),
  scheduledFor: isoDate.nullable(),
});
export type AcceptMissionResult = z.infer<typeof acceptMissionResultSchema>;

// ---------------------------------------------------------------- earnings

export const PAYOUT_STATUSES = ['pending', 'in_transit', 'paid', 'failed'] as const;

export const earningsSchema = z.object({
  /** Earned on completed jobs but not yet paid out. */
  pendingCents: cents.nonnegative(),
  /** Eligible for an instant payout right now. */
  availableCents: cents.nonnegative(),
  paidLast30DaysCents: cents.nonnegative(),
  paidYearToDateCents: cents.nonnegative(),
  completedMissions: z.number().int().nonnegative(),
  recentPayouts: z.array(
    z.object({
      id: z.string().min(1).max(100),
      missionTitle: z.string().max(200).nullable(),
      amountCents: cents.nonnegative(),
      status: z.enum(PAYOUT_STATUSES),
      date: isoDate,
    }),
  ),
});
export type Earnings = z.infer<typeof earningsSchema>;

// ---------------------------------------------------------------- credentials

export const CREDENTIAL_KINDS = ['faa_part107', 'insurance', 'id', 'drone_reg'] as const;
export const credentialKindSchema = z.enum(CREDENTIAL_KINDS);
export type CredentialKind = z.infer<typeof credentialKindSchema>;

/**
 * Status and expiry only. Certificate, policy, and registration numbers are
 * never part of this contract.
 */
export const credentialSummarySchema = z.object({
  verificationStatus: z.enum(['unverified', 'pending', 'verified', 'rejected']),
  standingTier: standingTierSchema.nullable(),
  /** Credentials lapsed: tier kept, perks off. */
  paused: z.boolean(),
  credentials: z.array(
    z.object({
      kind: credentialKindSchema,
      status: z.enum(['missing', 'pending', 'approved', 'rejected']),
      expiresAt: isoDate.nullable(),
      insuranceMode: z.enum(['annual', 'on_demand']).nullable().default(null),
    }),
  ),
});
export type CredentialSummary = z.infer<typeof credentialSummarySchema>;

// ---------------------------------------------------------------- bot settings

/**
 * How the user wants the bot to behave. Stored on Argus (edited in the pilot
 * portal's Discord bot page and with `/argus alerts`), enforced here by
 * `src/events/routing.ts`. Mirrors lib/platform/discord-bot/settings.ts on the
 * platform.
 */
export const ALERT_TYPES = [
  'mission.posted',
  'job.status_changed',
  'job.step',
  'job.deliverables_ready',
  'payout.paid',
  'payout.failed',
  'credential.expiring',
  'credential.reviewed',
  'dispute.updated',
] as const;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const botSettingsSchema = z.object({
  disabledAlerts: z.array(z.enum(ALERT_TYPES)).max(ALERT_TYPES.length),
  missionAlerts: z.object({
    minPayoutCents: z.number().int().min(0).nullable(),
    maxDistanceMi: z.number().int().min(1).nullable(),
  }),
  quietHours: z.object({
    enabled: z.boolean(),
    start: hhmm,
    end: hhmm,
    timezone: z.string().min(1).max(64),
    allowUrgent: z.boolean(),
  }),
});
export type BotSettings = z.infer<typeof botSettingsSchema>;

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  disabledAlerts: [],
  missionAlerts: { minPayoutCents: null, maxDistanceMi: null },
  quietHours: { enabled: false, start: '22:00', end: '07:00', timezone: 'America/Denver', allowUrgent: true },
};
