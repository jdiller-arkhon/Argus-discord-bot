# Handoff: deploying the Certa bot like Argus

Argus went live on Cloudflare on 2026-10-17 at `https://argus-bot.jdiller.workers.dev`. Certa
should be deployed the same way: the unchanged bot Docker image runs as one Cloudflare Container
instance, behind a small Worker, with D1 for storage. The files to copy and adapt are listed in the
last section.

This file lists only the names of the secrets. The values never go in a repo.

## What the Certa repo needs first

The Certa repo (`jdiller-arkhon/Certa-discord-bot`) has to be ported before it can deploy this way:

1. **Async storage.** Every database call goes through `SqlDb` from `@arkhon/shared`
   (`packages/shared/src/sql.ts`, `d1-bridge.ts`, `sqlite.ts`), so the same code runs on SQLite
   locally and on D1 through the Worker. Migrations must be valid on D1: no `PRAGMA`, and one
   statement per line ending in `;`.
2. **`D1_BRIDGE_URL` in the config schema.** When it is set, the bot uses `createD1BridgeDb` instead
   of a SQLite file.
3. **`deploy/cloudflare`.** Copy it from Argus and rename `argus-bot` and `ArgusBot` to
   `certa-bot` and `CertaBot`. Then:
   - set `ENV_KEYS`, `REQUIRED` and `DEFAULTS` in `src/deployment.ts` from Certa's `.env.example`;
   - point the image at Certa's Dockerfile.
4. **CI.** Copy `.github/workflows/ci-deploy.yml`.

**The Argus bot reads Certa's database.** Argus's `CERTA_DB_PATH` opens Certa's SQLite file
read-only. Once Certa is on D1, that file no longer exists, so that check has to read Certa's D1
database instead. Plan this change together with the Certa port.

## Cloudflare (shared with Argus and the Ops bot)

| Name | Where it goes | Value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Certa repo GitHub secret | `3b660fd445cde08f73deae1a4683a358`. This is not secret; it's shown under Workers & Pages → Account details |
| `CLOUDFLARE_API_TOKEN` | Certa repo GitHub secret | An account token with the permissions below |

The token needs these permissions on the account:
- Workers Scripts: Edit
- Containers: Edit
- D1: Edit
- Account Settings: Read

The **"arkhon-bots GitHub deploy"** token (rolled 2026-10-17) has these permissions and works for
all three bots. A separate token for each bot lets you revoke one without affecting the others. Whenever a
token is rolled, update `CLOUDFLARE_API_TOKEN` in the GitHub secrets of every repo that uses it,
**including the Ops bot repo**.

Make Certa its own D1 database (for example `certa-bot`) and put its id in `wrangler.jsonc`. The
existing databases are `argus-bot`, `arkhon-bots` (Ops) and `sentinel`.

## Discord (Certa's own application)

| Name | Required | Where to find it |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Developer portal → Certa app → Bot → Reset Token. This is secret |
| `DISCORD_APPLICATION_ID` | yes | General Information. Not secret, so it can be a default in `src/deployment.ts` the way Argus does it |
| `DISCORD_GUILD_ID` | recommended | Right-click the server → Copy Server ID. The Pilot Network is `1544539771735384226` |

Discord app settings, as for Argus:
- Public Bot off;
- all three privileged intents off, unless Certa really needs one;
- Guild Install only;
- invite with the `bot` and `applications.commands` scopes and only the permissions Certa uses.

## Certa's own settings

Copy every other name from Certa's `.env.example`, such as API base URL, API token, webhook secret,
channel IDs and role IDs. Where Certa shares a secret with the website or another service, the two
sides must hold the same value. Argus's shared pairs show the pattern:

| Bot (`argus-bot`) | Website (`arkhon-industries`) |
| --- | --- |
| `ARGUS_API_TOKEN` | `DISCORD_BOT_API_TOKEN` |
| `ARGUS_WEBHOOK_SECRET` | `DISCORD_BOT_WEBHOOK_SECRET` |
| (the Worker's URL) | `DISCORD_BOT_WEBHOOK_URL` = `https://argus-bot.jdiller.workers.dev/webhooks/argus` |

Generate new shared secrets with `openssl rand -hex 32`. Never reuse Argus's values.

The deployment sets these itself, so don't add them as secrets: `NODE_ENV`, the webhook host and
port, and `D1_BRIDGE_URL`.

## Deploy steps

1. Put every value above in the Certa repo's **GitHub Actions secrets**.
2. Run **Actions → CI and deploy**. It builds the image, deploys the Worker and container, and copies
   the secrets to the Worker with `wrangler secret bulk`.
3. Set any secrets the website needs from Certa on the `arkhon-industries` Worker.
4. Check `https://certa-bot.jdiller.workers.dev/healthz`. It returns `{"ok":true}` once the bot is
   connected to Discord, and 503 with the missing names if a required setting is absent.

## Deploying from a Claude cloud session instead of CI

Docker builds in Claude cloud sessions can't use the session's network proxy. For Argus this was
worked around by:
1. building with `--network host`, with the proxy's CA certificate added to the build stages only, and with `--provenance=false`;
2. running `wrangler containers push`;
3. deploying with the image reference in place of the Dockerfile path.

CI on GitHub Actions doesn't need any of that. Use it for Certa.

## Files to copy from Argus

- `deploy/cloudflare/`: `wrangler.jsonc`, `src/worker.ts`, `src/deployment.ts`,
  `scripts/write-secrets.ts`, `test/`
- `packages/shared/src/sql.ts`, `sqlite.ts`, `d1-bridge.ts`
- `.github/workflows/ci-deploy.yml`
- `docs/deploy.md`, which is the full walkthrough
