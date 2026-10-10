import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type Logger, verifySignature } from '@arkhon/shared';
import { ZodError } from 'zod';
import type { DispatchResult } from '../events/dispatch.js';
import { type ArgusEvent, eventEnvelopeSchema, isEventType, parseArgusEvent } from '../events/types.js';

export const WEBHOOK_PATH = '/webhooks/argus';
export const SIGNATURE_HEADER = 'x-argus-signature';
const MAX_BODY_BYTES = 256 * 1024;

export interface WebhookServerDeps {
  secret: string;
  logger: Logger;
  /** False until the Discord client is ready; Argus gets a 503 and retries. */
  isReady(): boolean;
  /** Records an event ID; false if it was already processed. */
  claimEvent(eventId: string, type: string): boolean;
  releaseEvent(eventId: string): void;
  dispatch(event: ArgusEvent): Promise<DispatchResult>;
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RequestError(413, 'payload too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * HTTP server for Argus events.
 *
 *   POST /webhooks/argus   JSON event envelope `{ id, type, occurredAt, userId, data }`,
 *                          signed with `X-Argus-Signature: sha256=<HMAC-SHA256 of the raw body>`.
 *                          200 handled (or duplicate), 202 unknown event type (ignored),
 *                          400 bad payload, 401 bad signature, 503 not connected yet,
 *                          500 delivery failed (Argus should retry with the same id).
 *   GET  /healthz          liveness + Discord readiness.
 */
export function createWebhookServer(deps: WebhookServerDeps): Server {
  const { logger } = deps;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/healthz') {
      const ready = deps.isReady();
      send(res, ready ? 200 : 503, { ok: ready });
      return;
    }
    if (path !== WEBHOOK_PATH) throw new RequestError(404, 'not found');
    if (req.method !== 'POST') throw new RequestError(405, 'method not allowed');

    const raw = await readBody(req);
    if (!verifySignature(raw, req.headers[SIGNATURE_HEADER], deps.secret)) {
      throw new RequestError(401, 'invalid signature');
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new RequestError(400, 'body must be JSON');
    }
    const envelope = eventEnvelopeSchema.parse(json);
    if (!isEventType(envelope.type)) {
      // Newer Argus versions may send types this bot does not know yet.
      send(res, 202, { ok: true, ignored: `unknown event type ${envelope.type}` });
      return;
    }
    const event = parseArgusEvent(json);

    if (!deps.isReady()) throw new RequestError(503, 'bot is not connected to Discord yet');
    if (!deps.claimEvent(event.id, event.type)) {
      send(res, 200, { ok: true, duplicate: true });
      return;
    }
    try {
      const result = await deps.dispatch(event);
      logger.info('Argus event handled', { eventId: event.id, type: event.type, ...result });
      send(res, 200, { ok: true, ...result });
    } catch (error) {
      deps.releaseEvent(event.id);
      throw error;
    }
  }

  return createServer((req, res) => {
    const started = performance.now();
    handle(req, res)
      .catch((error: unknown) => {
        if (error instanceof RequestError) {
          send(res, error.status, { ok: false, error: error.message });
        } else if (error instanceof ZodError) {
          send(res, 400, {
            ok: false,
            error: 'invalid payload',
            issues: error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
          });
        } else {
          logger.error('Argus webhook handler failed', { error });
          send(res, 500, { ok: false, error: 'internal error' });
        }
      })
      .finally(() => {
        logger.debug('Webhook request', {
          method: req.method,
          path: req.url,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        });
      });
  });
}
