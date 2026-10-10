import type { ScheduledJob } from '@arkhon/shared';
import type { ArgusContext } from './context.js';

/** Webhook IDs are kept this long to catch late Argus retries. */
export const PROCESSED_EVENT_RETENTION_DAYS = 30;

export function createJobs(context: ArgusContext): ScheduledJob[] {
  return [
    {
      name: 'prune-processed-events',
      schedule: { kind: 'daily', time: '03:30' },
      run: async () => {
        const removed = context.store.pruneProcessedEvents(PROCESSED_EVENT_RETENTION_DAYS);
        context.logger.info('Pruned processed Argus events', { removed });
      },
    },
  ];
}
