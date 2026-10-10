import type {
  AcceptMissionResult,
  CredentialSummary,
  Earnings,
  JobDetail,
  JobScope,
  JobSummary,
  LinkResult,
  MissionBoard,
  ServiceStatus,
} from './types.js';

/**
 * Everything the bot needs from the Argus platform. Commands depend only on
 * this interface; see HttpArgusClient (production) and MockArgusClient (local).
 */
export interface ArgusClient {
  /** Redeems a one-time code generated in Argus (Settings → Discord). */
  redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult>;
  getServiceStatus(): Promise<ServiceStatus>;
  /** Jobs the user booked (client) or was assigned (pilot). */
  listJobs(argusUserId: string, scope: JobScope): Promise<JobSummary[]>;
  getJob(argusUserId: string, jobId: number): Promise<JobDetail>;
  /** Open missions the pilot can see right now (respects standing-tier visibility delays). */
  listOpenMissions(argusUserId: string): Promise<MissionBoard>;
  /** Claims an open mission for the pilot. The only write; the bot confirms with a button first. */
  acceptMission(argusUserId: string, missionId: number): Promise<AcceptMissionResult>;
  getEarnings(argusUserId: string): Promise<Earnings>;
  getCredentials(argusUserId: string): Promise<CredentialSummary>;
}

export class ArgusError extends Error {
  override name = 'ArgusError';
}

/** The link code is unknown, expired, or already used. */
export class ArgusInvalidLinkCodeError extends ArgusError {
  override name = 'ArgusInvalidLinkCodeError';
}

/** The Argus user no longer exists (e.g. account deleted after linking). */
export class ArgusUserNotFoundError extends ArgusError {
  override name = 'ArgusUserNotFoundError';
}

/** A job or mission does not exist or is not visible to this user. */
export class ArgusNotFoundError extends ArgusError {
  override name = 'ArgusNotFoundError';
}

/** The backend refused the request (HTTP 400/403/409/422), e.g. a mission already taken. */
export class ArgusRejectedError extends ArgusError {
  override name = 'ArgusRejectedError';
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/** The bot's API token was rejected (HTTP 401). */
export class ArgusAuthError extends ArgusError {
  override name = 'ArgusAuthError';
}

/** Timeout, network error, or 5xx after all retries. */
export class ArgusUnavailableError extends ArgusError {
  override name = 'ArgusUnavailableError';
}

/** The backend responded with a body that does not match the expected schema. */
export class ArgusResponseError extends ArgusError {
  override name = 'ArgusResponseError';
}
