# Putting the Argus bot live on Cloudflare

The bot runs the same way as the Ops bot (`jdiller-arkhon/Arkhon-ops-bot`, `deploy/cloudflare`). The
setup has four parts:

- **The bot:** the unchanged `bots/argus/Dockerfile` image runs on **Cloudflare Containers** as one
  always-on instance. It holds the Discord gateway connection, so commands, buttons and DMs work
  exactly as they do anywhere else.
- **The Worker:** a small Worker (`deploy/cloudflare`, named `argus-bot`) sits in front of it. It
  forwards `/webhooks/argus` (alerts from the Arkhon website) and `/healthz`. It starts the
  container every 5 minutes if it isn't running, and restarts it when the settings change.
- **The database:** D1, in the `argus-bot` database, which already exists in the Cloudflare account.
  The container sends its queries to `http://d1.internal`. The Worker intercepts that address,
  which is never public, and runs the queries against the D1 binding. The bot applies its own
  migrations on startup.
- **The website:** the Arkhon site is already live. That covers the bot API at
  `https://arkhonindustries.com/api/bot/v1`, its tables, and the Pilot Network page, which is
  admins only while `DISCORD_BOT_ROLES` is `["admin"]`.

**Requirements:** the Cloudflare account must be on the **Workers Paid** plan, because Containers
aren't on the free plan. Deploys run from GitHub Actions, which has Docker, so you don't need
Docker on your own computer.

## 1. Make two shared secrets

On your own computer:

```bash
openssl rand -hex 32   # API token
openssl rand -hex 32   # webhook secret
```

Each one goes in two places, and must be identical in both:

| Secret | Website (`arkhon-industries` Worker) | Bot (GitHub secret, copied to the `argus-bot` Worker) |
| --- | --- | --- |
| API token | `DISCORD_BOT_API_TOKEN` | `ARGUS_API_TOKEN` |
| Webhook secret | `DISCORD_BOT_WEBHOOK_SECRET` | `ARGUS_WEBHOOK_SECRET` |

## 2. Create the Discord application

1. Go to https://discord.com/developers/applications and choose **New Application**. Name it
   `Argus`, and upload `assets/argus-icon.png` as the icon.
2. On **General Information**, copy the **Application ID**. That is `DISCORD_APPLICATION_ID`.
   Leave **Interactions Endpoint URL** blank.
3. On **Bot**:
   - choose **Reset Token** and copy the token. That is `DISCORD_TOKEN`;
   - upload `assets/argus-banner.png` as the banner;
   - turn **Public Bot** off;
   - leave all three privileged intents off.
4. On **Installation**, turn on Guild Install only. Give it the scopes `bot` and
   `applications.commands`, and permissions integer `360777509904`. The permissions are listed in
   `bots/argus/src/setup/checks.ts`. They do not include Administrator.
5. In Discord, turn on **Settings → Advanced → Developer Mode**. Then right-click and **Copy ID** on
   the Pilot Network server. That is `DISCORD_GUILD_ID`. Copy any channel and role IDs you want
   too:
   - `ARGUS_STATUS_CHANNEL_ID` and `ARGUS_STATUS_ROLE_ID`, for status posts;
   - `ARGUS_SUPPORT_CHANNEL_ID` and `ARGUS_STAFF_ROLE_ID`, for support tickets.
6. Invite the bot with this link, after putting in your IDs:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=360777509904&guild_id=<GUILD_ID>&disable_guild_select=true
   ```

## 3. Add the GitHub secrets

In GitHub, open **Argus-discord-bot → Settings → Secrets and variables → Actions** and add these
repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token. Use the **Edit Cloudflare Workers** template, and add **Account → D1 → Edit** and **Account → Containers → Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages, in the right-hand column |
| `DISCORD_TOKEN`, `DISCORD_GUILD_ID` | From step 2 |
| `ARGUS_API_TOKEN`, `ARGUS_WEBHOOK_SECRET` | From step 1 |
| Any optional settings | For example `ARGUS_STATUS_CHANNEL_ID`. Every name in `.env.example` is copied, except the ones the deployment sets itself |

`DISCORD_APPLICATION_ID` defaults to the Argus application (`1560080288967823510`), and
`ARGUS_CLIENT=http`, `ARGUS_API_BASE_URL` and `ARGUS_STATUS_URL` default to the live Arkhon site,
so you don't need to set them.

## 4. Deploy

Run **Actions → CI and deploy → Run workflow**. Every push to the default branch also deploys. The
workflow:

1. checks the code: typecheck, tests, build, and a Docker image build;
2. deploys the Worker and builds and pushes the bot image (`pnpm deploy:cloudflare`);
3. copies the bot settings from the GitHub secrets to the Worker (`wrangler secret bulk`). Only
   names from `.env.example` are copied, never the Cloudflare token.

Within 5 minutes, the cron starts the bot. It connects to Discord, registers `/argus` in your
server, and applies its D1 migrations. When a setting changes, the Worker restarts the bot within 5
minutes.

The Worker's address is `https://argus-bot.<your-subdomain>.workers.dev`, which you can find under
Workers & Pages → `argus-bot`. You can also give it a custom domain.

## 5. Point the website at the bot

In Cloudflare, open **Workers & Pages → `arkhon-industries` → Settings → Variables and Secrets**,
add these secrets, then deploy:

| Name | Value |
| --- | --- |
| `DISCORD_BOT_API_TOKEN` | API token from step 1 |
| `DISCORD_BOT_WEBHOOK_SECRET` | Webhook secret from step 1 |
| `DISCORD_BOT_WEBHOOK_URL` | `https://argus-bot.<your-subdomain>.workers.dev/webhooks/argus` |
| `PILOT_NETWORK_INVITE_URL` | Optional: the server's `https://discord.gg/…` invite, for the Join button |

## 6. Check it

- **Website:** go to Admin console → **Pilot Network → Bot connection → Check connection**. It
  checks the three settings above, that the bot is running and connected to Discord, and that
  both sides hold the same webhook secret.
- **Bot:** put the same values in a local `.env` and run
  `pnpm argus:doctor --public-url https://argus-bot.<your-subdomain>.workers.dev`. It checks the
  Discord token, the server, every channel ID and the Argus API token.
- **Logs:** `pnpm --filter @arkhon/argus-cloudflare tail`, or Workers & Pages → `argus-bot` → Logs.
  If a required setting is missing, `/healthz` answers 503 with the list.
- **End to end:** on the Pilot Network page, choose **Generate link code**. Run
  `/argus link code:<code>` in Discord, then choose **Send a test DM**.

## Opening it to pilots

In the website repo, change `DISCORD_BOT_ROLES` in `lib/platform/discord-bot/rollout.ts` from
`["admin"]` to `["admin", "pilot"]`, then deploy.

## Without Cloudflare

The same image runs anywhere Docker runs. Use `docker compose up -d --build argus` with a `.env`,
and it uses the SQLite file at `ARGUS_DB_PATH` instead of D1. Give the website
`https://<host>/webhooks/argus`, with TLS in front.
