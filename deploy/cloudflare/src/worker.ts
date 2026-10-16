/**
 * Cloudflare entry point for the Argus bot, after the Ops bot's deploy/cloudflare/src/worker.ts.
 *
 * The bot is the unchanged Docker image (bots/argus/Dockerfile) on Cloudflare Containers, as one
 * always-on instance. This Worker:
 *   - forwards /webhooks/argus (alerts from the Arkhon website) and /healthz to the container,
 *   - passes the Worker's secrets to the container as environment variables,
 *   - keeps the gateway connection alive: activity expiry is ignored, and a cron trigger starts the
 *     container after deploys, crashes or platform restarts,
 *   - restarts the container when the secrets change, so new values apply within 5 minutes,
 *   - serves the bot's database: queries the container sends to http://d1.internal run against the
 *     D1 binding (packages/shared/src/d1-bridge.ts). That host is never public.
 */
import { Container } from '@cloudflare/containers';
// Required for outboundByHost: the container's outbound requests are routed through this entrypoint.
export { ContainerProxy } from '@cloudflare/containers';
import { D1_BRIDGE_HOST, handleD1BridgeRequest } from '../../../packages/shared/src/d1-bridge.js';
import { BOT_PORT, containerEnv, envFingerprint, INSTANCE_NAME, isBotPath, missingRequired } from './deployment.js';

/** Storage key for the fingerprint of the configuration the running container started with. */
const STARTED_WITH = 'startedWithEnv';

interface Env {
  ARGUS_BOT: DurableObjectNamespace<ArgusBot>;
  DB: D1Database;
  [key: string]: unknown;
}

export class ArgusBot extends Container<Env> {
  override defaultPort = BOT_PORT;
  // Checked periodically; onActivityExpired keeps the instance running regardless.
  override sleepAfter = '1h';

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: Env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }

  /** A Discord bot holds a gateway connection with little inbound HTTP, so it must never sleep. */
  override async onActivityExpired(): Promise<void> {
    // Not stopping renews the activity timer (see @cloudflare/containers).
  }

  /** Remember which configuration this run started with. */
  override async onStart(): Promise<void> {
    await this.ctx.storage.put(STARTED_WITH, await envFingerprint(this.envVars ?? {}));
  }

  /** Stops the container when the Worker's settings changed since it started; the next check restarts it. */
  async restartIfConfigChanged(): Promise<boolean> {
    const state = await this.getState();
    if (state.status !== 'running' && state.status !== 'healthy') return false;
    const started = await this.ctx.storage.get<string>(STARTED_WITH);
    const current = await envFingerprint(this.envVars ?? {});
    if (!started || started === current) return false;
    await this.stop();
    for (let i = 0; i < 30; i++) {
      const { status } = await this.getState();
      if (status === 'stopped' || status === 'stopped_with_code') break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return true;
  }

  override onError(error: unknown): void {
    console.error(JSON.stringify({ msg: 'container error', bot: 'argus', error: String(error) }));
  }
}

// The database bridge, reachable only from inside the container. Assigned (not a static class
// field) so it goes through Container's setter, which registers handlers by class name.
ArgusBot.outboundByHost = {
  [D1_BRIDGE_HOST]: (request: Request, env: Env) => handleD1BridgeRequest(request, env.DB),
};

function instance(env: Env): DurableObjectStub<ArgusBot> {
  return env.ARGUS_BOT.getByName(INSTANCE_NAME);
}

async function ensureRunning(env: Env): Promise<void> {
  const missing = missingRequired(containerEnv(env));
  if (missing.length) {
    console.error(JSON.stringify({ msg: 'bot not started: missing configuration', bot: 'argus', missing }));
    return;
  }
  try {
    const stub = instance(env);
    if (await stub.restartIfConfigChanged()) {
      console.log(JSON.stringify({ msg: 'configuration changed: restarting', bot: 'argus' }));
    }
    const res = await stub.fetch('http://argus.internal/healthz');
    console.log(JSON.stringify({ msg: 'health check', bot: 'argus', status: res.status }));
  } catch (error) {
    console.error(JSON.stringify({ msg: 'health check failed', bot: 'argus', error: String(error) }));
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!isBotPath(new URL(request.url).pathname)) return new Response('Not found', { status: 404 });
    const missing = missingRequired(containerEnv(env));
    if (missing.length) return Response.json({ error: 'bot is not configured', missing }, { status: 503 });
    return instance(env).fetch(request);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(ensureRunning(env));
  },
} satisfies ExportedHandler<Env>;
