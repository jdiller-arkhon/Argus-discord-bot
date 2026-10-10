import { z } from 'zod';
import {
  credentialKindSchema,
  isoDate,
  jobStatusSchema,
  jobStepSchema,
  serviceStatusSchema,
} from '../argus/types.js';

const id = z.number().int().positive();
const title = z.string().min(1).max(200);

/** Data payload for each Argus event type. */
export const eventDataSchemas = {
  'service.status_changed': serviceStatusSchema,
  'mission.posted': z.object({
    missionId: id,
    title,
    serviceType: z.string().min(1).max(100),
    locality: z.string().max(100),
    distanceMi: z.number().nonnegative().nullable().default(null),
    payoutCents: z.number().int().nonnegative(),
    scheduledFor: isoDate.nullable(),
  }),
  'job.status_changed': z.object({ jobId: id, title, from: jobStatusSchema.nullable(), to: jobStatusSchema }),
  'job.step': z.object({ jobId: id, title, step: jobStepSchema, note: z.string().max(500).nullable().default(null) }),
  'job.deliverables_ready': z.object({ jobId: id, title, deliverableCount: z.number().int().positive() }),
  'payout.paid': z.object({ payoutId: z.string().min(1).max(100), amountCents: z.number().int().nonnegative(), missionTitle: title.nullable() }),
  'payout.failed': z.object({
    payoutId: z.string().min(1).max(100),
    amountCents: z.number().int().nonnegative(),
    reason: z.string().max(500).nullable().default(null),
  }),
  'credential.expiring': z.object({ kind: credentialKindSchema, expiresAt: isoDate, daysRemaining: z.number().int() }),
  'credential.reviewed': z.object({
    kind: credentialKindSchema,
    status: z.enum(['approved', 'rejected']),
    note: z.string().max(500).nullable().default(null),
  }),
  'dispute.updated': z.object({
    disputeId: id,
    jobId: id.nullable(),
    status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']),
    resolution: z.string().max(1000).nullable().default(null),
  }),
} as const;

export type ArgusEventType = keyof typeof eventDataSchemas;
export const EVENT_TYPES = Object.keys(eventDataSchemas) as ArgusEventType[];

export function isEventType(value: unknown): value is ArgusEventType {
  return typeof value === 'string' && Object.hasOwn(eventDataSchemas, value);
}

const envelopeBase = {
  /** Unique per event; Argus reuses it when retrying a delivery. */
  id: z.string().min(1).max(100),
  occurredAt: z.string().datetime({ offset: true }),
  /** Argus user the event belongs to; null for broadcast events. */
  userId: z.string().min(1).max(100).nullable().default(null),
};

export const argusEventSchema = z.discriminatedUnion(
  'type',
  EVENT_TYPES.map((type) => z.object({ ...envelopeBase, type: z.literal(type), data: eventDataSchemas[type] })) as unknown as [
    z.ZodDiscriminatedUnionOption<'type'>,
    ...z.ZodDiscriminatedUnionOption<'type'>[],
  ],
);

export type ArgusEvent = {
  [T in ArgusEventType]: {
    id: string;
    type: T;
    occurredAt: string;
    userId: string | null;
    data: z.infer<(typeof eventDataSchemas)[T]>;
  };
}[ArgusEventType];

export type EventOf<T extends ArgusEventType> = Extract<ArgusEvent, { type: T }>;

/** Envelope fields only, used to ignore unknown types before validating data. */
export const eventEnvelopeSchema = z.object({ ...envelopeBase, type: z.string().min(1).max(100) });

export function parseArgusEvent(raw: unknown): ArgusEvent {
  return argusEventSchema.parse(raw) as ArgusEvent;
}

/**
 * Event types a linked user can receive as DMs, in the order shown in
 * `/argus alerts`. `service.status_changed` is never personal.
 */
export interface PersonalAlert {
  type: Exclude<ArgusEventType, 'service.status_changed'>;
  label: string;
  description: string;
  /** Which linked accounts the alert applies to; admins see every alert. */
  audience: 'all' | 'pilot' | 'client';
}

export const PERSONAL_ALERTS = [
  { type: 'mission.posted', label: 'New missions near me', description: 'A mission in your service area is open', audience: 'pilot' },
  { type: 'job.status_changed', label: 'Job status changes', description: 'Scheduled, in progress, completed, cancelled', audience: 'all' },
  { type: 'job.step', label: 'Live job progress', description: 'Pilot en route, on site, in flight, uploading', audience: 'client' },
  { type: 'job.deliverables_ready', label: 'Deliverables ready', description: 'Imagery and reports are ready to review', audience: 'client' },
  { type: 'payout.paid', label: 'Payouts sent', description: 'A payout reached your account', audience: 'pilot' },
  { type: 'payout.failed', label: 'Payout problems', description: 'A payout failed and needs attention', audience: 'pilot' },
  { type: 'credential.expiring', label: 'Credential expiry', description: 'Part 107 or insurance expiring soon', audience: 'pilot' },
  { type: 'credential.reviewed', label: 'Credential reviews', description: 'An uploaded credential was approved or rejected', audience: 'pilot' },
  { type: 'dispute.updated', label: 'Dispute updates', description: 'A dispute on one of your jobs changed', audience: 'all' },
] as const satisfies readonly PersonalAlert[];

/** Alerts shown in `/argus alerts` for a linked account role. */
export function alertsForRole(role: 'client' | 'pilot' | 'admin'): readonly PersonalAlert[] {
  return PERSONAL_ALERTS.filter((alert) => role === 'admin' || alert.audience === 'all' || alert.audience === role);
}

export type PersonalAlertType = (typeof PERSONAL_ALERTS)[number]['type'];

export function isPersonalAlertType(value: unknown): value is PersonalAlertType {
  return PERSONAL_ALERTS.some((alert) => alert.type === value);
}
