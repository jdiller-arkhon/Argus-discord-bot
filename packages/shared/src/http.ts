export type FetchFn = typeof fetch;

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Serialized as JSON with a `content-type: application/json` header. */
  json?: unknown;
  /** Per-attempt timeout. Default 10s. */
  timeoutMs?: number;
  /** Total attempts including the first. Default 1 (no retries). */
  attempts?: number;
  /** Base delay for exponential backoff: base, base*2, base*4... Default 500ms. */
  backoffMs?: number;
  fetchFn?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
}

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(message);
  }
}

export class HttpTimeoutError extends Error {
  override name = 'HttpTimeoutError';
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
  }
}

export class HttpNetworkError extends Error {
  override name = 'HttpNetworkError';
  constructor(
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(`Network error requesting ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status >= 500;
  return error instanceof HttpTimeoutError || error instanceof HttpNetworkError;
}

async function attempt(url: string, options: RequestOptions, fetchFn: FetchFn, timeoutMs: number): Promise<HttpResponse> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status} from ${url}`, response.status, url, text.slice(0, 2000));
    }
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (controller.signal.aborted) throw new HttpTimeoutError(url, timeoutMs);
    throw new HttpNetworkError(url, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Performs an HTTP request with a per-attempt timeout. 5xx responses, timeouts
 * and network errors are retried with exponential backoff up to `attempts`
 * total tries; 4xx responses fail immediately.
 */
export async function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  const attempts = Math.max(1, options.attempts ?? 1);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const backoffMs = options.backoffMs ?? 500;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await attempt(url, options, fetchFn, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || i === attempts - 1) throw error;
      await sleep(backoffMs * 2 ** i);
    }
  }
  throw lastError;
}

/** Like {@link request} but parses the body as JSON. Empty bodies yield `null`. */
export async function requestJson(url: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await request(url, options);
  if (response.text.trim() === '') return null;
  return JSON.parse(response.text) as unknown;
}
