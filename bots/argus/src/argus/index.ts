import type { Db } from '@arkhon/shared';
import type { ArgusConfig } from '../config.js';
import type { ArgusClient } from './client.js';
import { HttpArgusClient } from './http-client.js';
import { MockArgusClient } from './mock-client.js';

export * from './client.js';
export * from './types.js';
export { HttpArgusClient } from './http-client.js';
export { MockArgusClient } from './mock-client.js';

/**
 * Picks the Argus client implementation from `ARGUS_CLIENT`. In mock mode,
 * `ARGUS_STATUS_URL` still applies, so `/argus status` and #argus-status can
 * follow the real platform's health probe before the bot API exists.
 */
export function createArgusClient(config: ArgusConfig, db: Db): ArgusClient {
  const statusUrl = config.env.ARGUS_STATUS_URL;
  if (config.env.ARGUS_CLIENT === 'mock') {
    const mock = new MockArgusClient(db, { timezone: config.timezone });
    if (!statusUrl) return mock;
    // The token is never sent to the status URL, so none is configured here.
    const status = new HttpArgusClient({ baseUrl: statusUrl, token: '', statusUrl });
    return withStatusFrom(mock, status);
  }
  // Presence is guaranteed by the config schema when ARGUS_CLIENT=http.
  return new HttpArgusClient({
    baseUrl: config.env.ARGUS_API_BASE_URL!,
    token: config.env.ARGUS_API_TOKEN!,
    statusUrl,
  });
}

/** Uses `statusSource` for service status and `client` for everything else. */
export function withStatusFrom(client: ArgusClient, statusSource: Pick<ArgusClient, 'getServiceStatus'>): ArgusClient {
  return {
    redeemLinkCode: (code, discordUserId) => client.redeemLinkCode(code, discordUserId),
    getServiceStatus: () => statusSource.getServiceStatus(),
    listJobs: (userId, scope) => client.listJobs(userId, scope),
    getJob: (userId, jobId) => client.getJob(userId, jobId),
    listOpenMissions: (userId) => client.listOpenMissions(userId),
    acceptMission: (userId, missionId) => client.acceptMission(userId, missionId),
    getEarnings: (userId) => client.getEarnings(userId),
    getCredentials: (userId) => client.getCredentials(userId),
    getBotSettings: (userId) => client.getBotSettings(userId),
    updateBotSettings: (userId, settings) => client.updateBotSettings(userId, settings),
  };
}
