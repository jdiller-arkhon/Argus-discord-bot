import type { Logger } from '@arkhon/shared';
import type { ServiceState, ServiceStatus } from '../argus/types.js';

export interface StatusMemory {
  /** State last announced in the status channel; null before the first observation. */
  announced: ServiceState | null;
  /** A different state seen on recent polls but not yet confirmed. */
  pending: ServiceState | null;
  pendingCount: number;
}

export interface StatusAnnouncement {
  from: ServiceState;
  to: ServiceState;
  /** Ping the status role: only when things got worse into degraded or outage. */
  ping: boolean;
}

export const PING_STATES: readonly ServiceState[] = ['degraded', 'outage'];

/**
 * Pure status-change logic.
 *
 * - The first observation ever is recorded silently (nothing to compare to).
 * - A new state must be observed `confirmations` times in a row before it is
 *   announced, so one failed poll does not page anyone. Webhook updates come
 *   from Argus itself and are applied with `confirmations = 1`.
 * - Seeing the announced state again clears any pending change.
 * - Only degraded and outage ping the role; recovery and maintenance post quietly.
 */
export function evaluateStatus(
  memory: StatusMemory,
  observed: ServiceState,
  confirmations: number,
): { memory: StatusMemory; announce: StatusAnnouncement | null } {
  if (memory.announced === null) {
    return { memory: { announced: observed, pending: null, pendingCount: 0 }, announce: null };
  }
  if (observed === memory.announced) {
    return { memory: { announced: observed, pending: null, pendingCount: 0 }, announce: null };
  }
  const count = memory.pending === observed ? memory.pendingCount + 1 : 1;
  if (count >= Math.max(1, confirmations)) {
    return {
      memory: { announced: observed, pending: null, pendingCount: 0 },
      announce: { from: memory.announced, to: observed, ping: PING_STATES.includes(observed) },
    };
  }
  return { memory: { announced: memory.announced, pending: observed, pendingCount: count }, announce: null };
}

export interface StatusMonitorDeps {
  load(): StatusMemory;
  save(memory: StatusMemory): void;
  /** Posts the announcement; throws if the post failed. */
  announce(announcement: StatusAnnouncement, status: ServiceStatus): Promise<void>;
  logger: Logger;
  pollConfirmations: number;
}

/**
 * Applies status observations from polling and webhooks one at a time and
 * announces confirmed changes. If posting fails the memory is not advanced,
 * so the change is announced on the next observation instead of being lost.
 */
export class StatusMonitor {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StatusMonitorDeps) {}

  observe(status: ServiceStatus, source: 'poll' | 'webhook'): Promise<StatusAnnouncement | null> {
    const run = this.queue.then(() => this.apply(status, source));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async apply(status: ServiceStatus, source: 'poll' | 'webhook'): Promise<StatusAnnouncement | null> {
    const confirmations = source === 'webhook' ? 1 : this.deps.pollConfirmations;
    const result = evaluateStatus(this.deps.load(), status.state, confirmations);
    if (result.announce) {
      await this.deps.announce(result.announce, status);
      this.deps.logger.info('Argus status change announced', { ...result.announce, source });
    }
    this.deps.save(result.memory);
    return result.announce;
  }
}
