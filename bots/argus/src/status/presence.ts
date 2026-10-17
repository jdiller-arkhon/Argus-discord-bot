import { ActivityType, type PresenceData } from 'discord.js';
import type { ServiceState } from '../argus/types.js';

/**
 * The bot's Discord presence for a service state. Argus is the hundred-eyed watchman, so it is
 * 'Watching' the network while all is well; anything else shows what members see in /argus status.
 */
export function presenceFor(state: ServiceState | null): PresenceData {
  switch (state) {
    case 'maintenance':
      return {
        status: 'idle',
        activities: [
          {
            type: ActivityType.Custom,
            name: 'maintenance',
            state: '🛠️ Scheduled maintenance · /argus status',
          },
        ],
      };
    case 'degraded':
      return {
        status: 'idle',
        activities: [
          {
            type: ActivityType.Custom,
            name: 'degraded',
            state: '🟡 Degraded service · /argus status',
          },
        ],
      };
    case 'outage':
      return {
        status: 'dnd',
        activities: [
          {
            type: ActivityType.Custom,
            name: 'outage',
            state: '🔴 Argus outage · /argus status',
          },
        ],
      };
    default:
      return {
        status: 'online',
        activities: [
          {
            type: ActivityType.Watching,
            name: 'the skies over the Pilot Network',
          },
        ],
      };
  }
}
