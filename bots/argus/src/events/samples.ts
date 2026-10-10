import { randomUUID } from 'node:crypto';
import type { ServiceState } from '../argus/types.js';
import type { ArgusEvent, ArgusEventType } from './types.js';

/**
 * A realistic example event of each type, used by `pnpm argus:event` and the
 * tests. `userId` null makes it a broadcast; personal types need an Argus user ID.
 */
export function sampleEvent(
  type: ArgusEventType,
  options: { userId?: string | null; now?: Date; state?: ServiceState } = {},
): ArgusEvent {
  const now = options.now ?? new Date();
  const base = { id: `evt_${randomUUID()}`, occurredAt: now.toISOString(), userId: options.userId ?? null };
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);

  switch (type) {
    case 'service.status_changed': {
      const state = options.state ?? 'degraded';
      return {
        ...base,
        userId: null,
        type,
        data: {
          state,
          summary: state === 'operational' ? null : 'Deliverable uploads are slower than usual.',
          components: [{ name: 'Deliverable uploads', state }],
          updatedAt: now.toISOString(),
        },
      };
    }
    case 'mission.posted':
      return {
        ...base,
        type,
        data: {
          missionId: 512,
          title: 'Listing photos: 4-bed home',
          serviceType: 'Real Estate Photography',
          serviceId: 'realestate',
          locality: 'Golden, CO',
          distanceMi: 12.4,
          payoutCents: 18_000,
          scheduledFor: inDays(2),
        },
      };
    case 'job.status_changed':
      return { ...base, type, data: { jobId: 1042, title: 'Roof inspection: 1420 Pine St', from: 'scheduled', to: 'in_progress' } };
    case 'job.step':
      return { ...base, type, data: { jobId: 1042, title: 'Roof inspection: 1420 Pine St', step: 'in_flight', note: null } };
    case 'job.deliverables_ready':
      return { ...base, type, data: { jobId: 1042, title: 'Roof inspection: 1420 Pine St', deliverableCount: 3 } };
    case 'payout.paid':
      return { ...base, type, data: { payoutId: 'po_1001', amountCents: 26_500, missionTitle: 'Roof inspection: 1420 Pine St' } };
    case 'payout.failed':
      return { ...base, type, data: { payoutId: 'po_1002', amountCents: 26_500, reason: 'The bank declined the transfer.' } };
    case 'credential.expiring':
      return { ...base, type, data: { kind: 'insurance', expiresAt: inDays(14), daysRemaining: 14 } };
    case 'credential.reviewed':
      return { ...base, type, data: { kind: 'faa_part107', status: 'approved', note: null } };
    case 'account.test':
      return { ...base, type, data: { requestedAt: now.toISOString() } };
    case 'digest.daily':
      return {
        ...base,
        type,
        data: {
          date: now.toISOString().slice(0, 10),
          timezone: 'America/Denver',
          todayJobs: [
            {
              id: 1042,
              title: 'Roof Inspection · Boulder, CO',
              serviceType: 'Roof Inspection',
              status: 'scheduled',
              paymentStatus: 'paid',
              scheduledFor: now.toISOString().slice(0, 10),
              timeWindow: 'morning',
              amountCents: 26_500,
              locality: 'Boulder, CO',
              viewerRole: 'pilot',
              counterpartName: 'Cal M.',
              latestStep: null,
            },
          ],
          upcomingJobs: 2,
          awaitingReview: 0,
          pilot: {
            onDuty: true,
            canAccept: true,
            openMissions: 3,
            bestPayoutCents: 61_000,
            pendingPayoutCents: 87_000,
            credentialAlerts: [{ kind: 'insurance', status: 'approved', expiresAt: inDays(14), insuranceMode: 'annual' }],
          },
        },
      };
    case 'dispute.updated':
      return { ...base, type, data: { disputeId: 77, jobId: 1042, status: 'resolved', resolution: 'Partial refund issued to the client.' } };
  }
}
