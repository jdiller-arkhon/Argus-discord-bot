import { randomUUID } from 'node:crypto';
import { type FetchFn, HttpError, HttpNetworkError, HttpTimeoutError, requestJson } from '@arkhon/shared';
import { z } from 'zod';
import {
  type ArgusClient,
  ArgusAuthError,
  ArgusError,
  ArgusInvalidLinkCodeError,
  ArgusNotFoundError,
  ArgusRejectedError,
  ArgusResponseError,
  ArgusUnavailableError,
  ArgusUserNotFoundError,
} from './client.js';
import {
  type AcceptMissionResult,
  acceptMissionResultSchema,
  type BotSettings,
  botSettingsSchema,
  dutySchema,
  type FieldStepResult,
  fieldStepResultSchema,
  type JobStep,
  type PilotStats,
  pilotStatsSchema,
  type TodaySummary,
  todaySummarySchema,
  type CredentialSummary,
  credentialSummarySchema,
  type Earnings,
  earningsSchema,
  healthResponseSchema,
  type JobDetail,
  jobDetailSchema,
  jobListSchema,
  type JobScope,
  type JobSummary,
  type LinkResult,
  linkResultSchema,
  type MissionBoard,
  missionBoardSchema,
  type ServiceStatus,
  serviceStatusSchema,
} from './types.js';

export interface HttpArgusClientOptions {
  baseUrl: string;
  token: string;
  /**
   * Optional separate status endpoint. It may return a full ServiceStatus or
   * the platform's existing `GET /api/health` body (`{ ok, db }`). The API
   * token is never sent to it.
   */
  statusUrl?: string;
  timeoutMs?: number;
  attempts?: number;
  backoffMs?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** What a 404 means for a given call. */
type NotFoundMeaning = 'user' | 'link-code' | 'resource';

/**
 * Argus REST client. Every request uses a bearer token, a 10s per-attempt
 * timeout, and up to 3 attempts with exponential backoff (500ms, 1s) on
 * 5xx/timeouts. POSTs carry an `Idempotency-Key` so retries cannot accept a
 * mission twice. Responses are validated with zod.
 */
export class HttpArgusClient implements ArgusClient {
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly options: HttpArgusClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.now = options.now ?? (() => new Date());
  }

  async redeemLinkCode(code: string, discordUserId: string): Promise<LinkResult> {
    return this.call(linkResultSchema, 'POST', '/v1/discord/link-codes/redeem', {
      body: { code, discordUserId },
      notFound: 'link-code',
    });
  }

  async getServiceStatus(): Promise<ServiceStatus> {
    if (!this.options.statusUrl) {
      return this.call(serviceStatusSchema, 'GET', '/v1/status', {});
    }
    return this.fetchStatusUrl(this.options.statusUrl);
  }

  async listJobs(argusUserId: string, scope: JobScope): Promise<JobSummary[]> {
    const result = await this.call(jobListSchema, 'GET', `${userPath(argusUserId)}/jobs?scope=${scope}`, { notFound: 'user' });
    return result.jobs;
  }

  async getJob(argusUserId: string, jobId: number): Promise<JobDetail> {
    return this.call(jobDetailSchema, 'GET', `${userPath(argusUserId)}/jobs/${jobId}`, { notFound: 'resource' });
  }

  async listOpenMissions(argusUserId: string): Promise<MissionBoard> {
    return this.call(missionBoardSchema, 'GET', `${userPath(argusUserId)}/missions/open`, { notFound: 'user' });
  }

  async acceptMission(argusUserId: string, missionId: number): Promise<AcceptMissionResult> {
    return this.call(acceptMissionResultSchema, 'POST', `${userPath(argusUserId)}/missions/${missionId}/accept`, {
      body: {},
      notFound: 'resource',
    });
  }

  async getEarnings(argusUserId: string): Promise<Earnings> {
    return this.call(earningsSchema, 'GET', `${userPath(argusUserId)}/earnings`, { notFound: 'user' });
  }

  async getCredentials(argusUserId: string): Promise<CredentialSummary> {
    return this.call(credentialSummarySchema, 'GET', `${userPath(argusUserId)}/credentials`, { notFound: 'user' });
  }

  async getBotSettings(argusUserId: string): Promise<BotSettings> {
    return this.call(botSettingsSchema, 'GET', `${userPath(argusUserId)}/settings`, { notFound: 'user' });
  }

  async updateBotSettings(argusUserId: string, settings: BotSettings): Promise<BotSettings> {
    return this.call(botSettingsSchema, 'PUT', `${userPath(argusUserId)}/settings`, { body: settings, notFound: 'user' });
  }

  async getToday(argusUserId: string): Promise<TodaySummary> {
    return this.call(todaySummarySchema, 'GET', `${userPath(argusUserId)}/today`, { notFound: 'user' });
  }

  async getStats(argusUserId: string): Promise<PilotStats> {
    return this.call(pilotStatsSchema, 'GET', `${userPath(argusUserId)}/stats`, { notFound: 'user' });
  }

  async getDuty(argusUserId: string): Promise<boolean> {
    return (await this.call(dutySchema, 'GET', `${userPath(argusUserId)}/duty`, { notFound: 'user' })).onDuty;
  }

  async setDuty(argusUserId: string, onDuty: boolean): Promise<boolean> {
    return (await this.call(dutySchema, 'PUT', `${userPath(argusUserId)}/duty`, { body: { onDuty }, notFound: 'user' })).onDuty;
  }

  async postJobStep(argusUserId: string, jobId: number, step: JobStep, note: string | null): Promise<FieldStepResult> {
    return this.call(fieldStepResultSchema, 'POST', `${userPath(argusUserId)}/jobs/${jobId}/steps`, {
      body: { step, note },
      notFound: 'resource',
    });
  }

  async unlinkAccount(argusUserId: string): Promise<void> {
    await this.call(z.object({ unlinked: z.boolean() }), 'DELETE', `${userPath(argusUserId)}/link`, { notFound: 'user' });
  }

  /**
   * A status endpoint that is down *is* the status: 5xx and timeouts after
   * retries are reported as an outage rather than thrown.
   */
  private async fetchStatusUrl(url: string): Promise<ServiceStatus> {
    let raw: unknown;
    try {
      raw = await requestJson(url, this.requestOptions({}));
    } catch (error) {
      if (
        (error instanceof HttpError && error.status >= 500) ||
        error instanceof HttpTimeoutError ||
        error instanceof HttpNetworkError
      ) {
        return {
          state: 'outage',
          summary: 'Argus is not responding to health checks.',
          components: [],
          updatedAt: this.now().toISOString(),
        };
      }
      throw translateError(error, undefined);
    }

    const full = serviceStatusSchema.safeParse(raw);
    if (full.success) return full.data;
    const health = healthResponseSchema.safeParse(raw);
    if (health.success) {
      return {
        state: health.data.ok ? 'operational' : 'outage',
        summary: health.data.ok ? null : 'Argus reports it cannot reach its database.',
        components: health.data.db ? [{ name: 'Database', state: health.data.db === 'ok' ? 'operational' : 'outage' }] : [],
        updatedAt: this.now().toISOString(),
      };
    }
    throw new ArgusResponseError(`Unexpected response from the Argus status endpoint: ${full.error.message}`);
  }

  private requestOptions(extra: { method?: string; headers?: Record<string, string>; json?: unknown }) {
    return {
      ...extra,
      timeoutMs: this.options.timeoutMs ?? 10_000,
      attempts: this.options.attempts ?? 3,
      backoffMs: this.options.backoffMs ?? 500,
      fetchFn: this.options.fetchFn,
      sleep: this.options.sleep,
    };
  }

  private async call<S extends z.ZodTypeAny>(
    schema: S,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { body?: unknown; notFound?: NotFoundMeaning },
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` };
    if (method === 'POST') headers['idempotency-key'] = randomUUID();

    let raw: unknown;
    try {
      raw = await requestJson(`${this.baseUrl}${path}`, this.requestOptions({ method, headers, json: opts.body }));
    } catch (error) {
      throw translateError(error, opts.notFound);
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ArgusResponseError(`Unexpected response from Argus ${method} ${path.split('?')[0]}: ${parsed.error.message}`);
    }
    return parsed.data;
  }
}

function userPath(argusUserId: string): string {
  return `/v1/users/${encodeURIComponent(argusUserId)}`;
}

/** Error bodies are `{ code?: string, message?: string }`. */
function errorBody(body: string): { code?: string; message?: string } {
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown; error?: unknown };
    return {
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      message:
        typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : undefined,
    };
  } catch {
    return {};
  }
}

export function translateError(error: unknown, notFound: NotFoundMeaning | undefined): ArgusError {
  if (error instanceof HttpError) {
    const { code, message } = errorBody(error.body);
    if (error.status === 401) return new ArgusAuthError('Argus rejected the bot API token');
    if (error.status === 403) {
      // A permission refusal for this user (e.g. a client asking for pilot data)
      // carries code "not_allowed"; anything else is a bad bot token.
      return code === 'not_allowed'
        ? new ArgusRejectedError('Argus refused the request', message)
        : new ArgusAuthError('Argus rejected the bot API token');
    }
    if (error.status === 404 || error.status === 410) {
      if (notFound === 'link-code') return new ArgusInvalidLinkCodeError(message ?? 'Link code is invalid, expired, or already used');
      if (notFound === 'user' || code === 'user_not_found') return new ArgusUserNotFoundError(message ?? 'Argus user not found');
      if (notFound === 'resource') return new ArgusNotFoundError(message ?? 'Not found');
    }
    if (error.status === 400 || error.status === 409 || error.status === 422) {
      return new ArgusRejectedError('Argus rejected the request', message);
    }
    if (error.status >= 500) return new ArgusUnavailableError(`Argus returned HTTP ${error.status} after retries`);
    return new ArgusError(`Argus returned HTTP ${error.status}`);
  }
  if (error instanceof HttpTimeoutError || error instanceof HttpNetworkError) {
    return new ArgusUnavailableError(error.message);
  }
  if (error instanceof SyntaxError) return new ArgusResponseError('Argus returned a non-JSON response');
  return new ArgusError(error instanceof Error ? error.message : String(error));
}
