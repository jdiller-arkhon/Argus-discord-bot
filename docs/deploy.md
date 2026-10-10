# Putting the Argus bot live

The website side is live: the bot API at `https://arkhonindustries.com/api/bot/v1`, its database
tables, and the Pilot Network page (admins only, `DISCORD_BOT_ROLES` in the website repo). Three
things still need your accounts: a Discord application, a host for the bot, and three settings on
the website's Cloudflare Worker.

The steps below use [Fly.io](https://fly.io) because `fly.toml` in this repo is ready to go (about
$3–5 a month for one small machine and a 1 GB volume). Any host that runs a Docker container
around the clock, keeps a disk between deploys, and serves HTTPS works the same way.

## 1. Make two secrets

On your own computer:

```bash
openssl rand -hex 32   # API token
openssl rand -hex 32   # webhook secret
```

Keep both in a password manager. Each one goes in two places, and must be identical in both:

| Secret | Website (Cloudflare Worker) | Bot (Fly) |
| --- | --- | --- |
| API token | `DISCORD_BOT_API_TOKEN` | `ARGUS_API_TOKEN` |
| Webhook secret | `DISCORD_BOT_WEBHOOK_SECRET` | `ARGUS_WEBHOOK_SECRET` |

## 2. Create the Discord application

1. Open https://discord.com/developers/applications → **New Application** → name it `Argus`.
2. **General Information:** copy the **Application ID** (`DISCORD_APPLICATION_ID`). Set the
   icon to the Pilot Network mark if you like.
3. **Bot:** click **Reset Token** and copy it (`DISCORD_TOKEN`). Leave every **Privileged Gateway
   Intent** off; the bot doesn't need them. Turn **Public Bot** off so only you can invite it.
4. In Discord, turn on **Settings → Advanced → Developer Mode**. Then right-click to **Copy ID** on:
   - the Arkhon Pilot Network server (`DISCORD_GUILD_ID`);
   - `#argus-status` (`ARGUS_STATUS_CHANNEL_ID`), and the role to ping on outages
     (`ARGUS_STATUS_ROLE_ID`), if you want status posts;
   - the support channel (`ARGUS_SUPPORT_CHANNEL_ID`) and staff role (`ARGUS_STAFF_ROLE_ID`), if
     you want support tickets in Discord. Set both or neither.
5. Invite the bot to the server with this link, after putting in your Application ID and server ID:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=360777509904&guild_id=<GUILD_ID>&disable_guild_select=true
   ```

   `pnpm argus:doctor` prints this link for you once the IDs are set. The permissions are listed in
   `bots/argus/src/setup/checks.ts`. They do not include Administrator.

## 3. Deploy the bot to Fly

Install the CLI (https://fly.io/docs/flyctl/install/) and sign in with `fly auth login`. Then, from
this repo:

```bash
fly launch --copy-config --no-deploy          # accept the name or pick one; keep the den region
fly volumes create argus_data --size 1 --region den

fly secrets set \
  DISCORD_TOKEN='<bot token>' \
  DISCORD_APPLICATION_ID='<application id>' \
  DISCORD_GUILD_ID='<server id>' \
  ARGUS_API_TOKEN='<API token from step 1>' \
  ARGUS_WEBHOOK_SECRET='<webhook secret from step 1>'

# Optional, as needed:
fly secrets set ARGUS_STATUS_CHANNEL_ID='…' ARGUS_STATUS_ROLE_ID='…'
fly secrets set ARGUS_SUPPORT_CHANNEL_ID='…' ARGUS_STAFF_ROLE_ID='…' ARGUS_TICKET_ARCHIVE_CHANNEL_ID='…'

fly deploy
```

The bot's address is `https://<app name>.fly.dev` (`fly status` shows it). The bot registers its
slash commands in your server when it starts.

## 4. Point the website at the bot

In Cloudflare → **Workers & Pages** → `arkhon-industries` → **Settings** → **Variables and
Secrets**, add three **Secrets**:

| Name | Value |
| --- | --- |
| `DISCORD_BOT_API_TOKEN` | API token from step 1 |
| `DISCORD_BOT_WEBHOOK_SECRET` | webhook secret from step 1 |
| `DISCORD_BOT_WEBHOOK_URL` | `https://<app name>.fly.dev/webhooks/argus` |

Optionally add `PILOT_NETWORK_INVITE_URL` with the server's invite link (`https://discord.gg/…`)
to show **Join the server** on the Pilot Network page.

Click **Deploy** so the Worker picks them up.

## 5. Check it

- **From the bot:** put the same values in a local `.env` (copy `.env.example`), then run
  `pnpm argus:doctor --public-url https://<app name>.fly.dev`. It checks the Discord token, the
  server, every channel ID, the Argus API token and the public address, and says what to fix. It
  also prints the invite link.
- **From the website:** Admin console → **Pilot Network** → **Bot connection** → **Check
  connection**. It checks the three Cloudflare settings and sends the bot a signed test, so it
  catches a webhook secret that differs between the two sides.
- **End to end:** on the same page, **Generate link code**, run `/argus link code:<code>` in the
  server, then **Send a test DM**.

## Opening it to pilots

Pilots can't link until the website lets them. In the website repo, change `DISCORD_BOT_ROLES` in
`lib/platform/discord-bot/rollout.ts` from `["admin"]` to `["admin", "pilot"]` and deploy.

## Day to day

```bash
fly logs                 # JSON log lines; IDs only, never tokens
fly deploy               # after pulling changes
fly ssh console          # a shell in the container; the database is /app/data/argus.sqlite
```

To rotate a secret, make a new one, set it on both sides (`fly secrets set …` and Cloudflare), and
redeploy both. Alerts pause until both sides match.
