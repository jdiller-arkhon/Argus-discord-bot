# Argus Discord bot

Discord bot for **Argus**, the platform behind the Arkhon Industries drone-services marketplace.
Clients follow their jobs, pilots find and accept missions, and both get DM alerts. Everyone can
check service status and reach support. It is part of the Arkhon bots, with the Certa and Ops bots,
and follows the same conventions (see `CLAUDE.md`).

## Features

- **Account linking:** `/argus link code:<code>` with a one-time code from Argus, and `/argus unlink`.
  The confirmation mentions it when you are also linked to Certa.
- **Status:** `/argus status`, plus automatic posts to `#argus-status` when Argus changes state.
  The role is pinged only for degraded or outage.
- **Event alerts:** a signed `POST /webhooks/argus` endpoint. Personal events are DMed to the linked
  user, and broadcasts go to configured channels. Users choose their DMs with `/argus alerts`.
- **Product commands:** `/argus jobs`, `/argus job id:<n>`, `/argus missions` (accept with
  confirmation), `/argus earnings`, and `/argus credentials`.
- **Support:** `/argus help` shows FAQ answers from `bots/argus/faq.json` and a button that opens a
  private support ticket through the shared ticket flow.

## Quick start (mock mode, no Argus API needed)

Requires Node 22 and pnpm 10.

```bash
pnpm install
cp .env.example .env      # set DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID; keep ARGUS_CLIENT=mock
pnpm argus:dev
```

In Discord:

1. Run `/argus link code:PILOT-123456`. Use `CLIENT-123456` for a client account. Any 6–32 character code works once.
2. Try `/argus jobs`, `/argus job`, `/argus missions`, `/argus earnings`, `/argus credentials`, `/argus alerts`, `/argus help`, and `/argus status`.

To test events and status locally, set `ARGUS_WEBHOOK_SECRET` (and optionally
`ARGUS_STATUS_CHANNEL_ID`), then:

```bash
pnpm argus:event payout.paid --discord <your Discord user ID>   # DM alert
pnpm argus:event service.status_changed --state outage          # status post + role ping
pnpm argus:mock-status degraded Uploads are slow                # picked up by the poller
```

## Docker

```bash
cp .env.example .env   # fill in
docker compose up -d --build argus
```

The container stores its SQLite database in the `argus-data` volume and listens on port 8080 for
Argus webhooks. Put TLS in front of it and give Argus `https://<host>/webhooks/argus`. To mention
Certa links, mount the Certa bot's data volume read-only and set `CERTA_DB_PATH` (commented out in
`docker-compose.yml`).

## Discord setup

1. Create an application and bot at https://discord.com/developers/applications. No privileged
   intents are needed.
2. Invite it with the `bot` and `applications.commands` scopes.
3. Grant these permissions:
   - Send Messages, Embed Links, and Read Message History in `#argus-status` and any event channels.
   - Create Private Threads, Send Messages in Threads, and Manage Threads in the support channel.
   - Manage Channels in the ticket category, if you use channel mode or the fallback.
4. Make the status role mentionable, or give the bot **Mention @everyone, @here, and All Roles**.
5. Commands register on startup: in `DISCORD_GUILD_ID` if set (instant), globally otherwise.

## Configuration

Every variable is documented in `.env.example`. Blank values use the default.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID` | required | Bot credentials |
| `DISCORD_GUILD_ID` | | Register commands to one guild |
| `ARGUS_CLIENT` | `http` | `http` or `mock` |
| `ARGUS_API_BASE_URL`, `ARGUS_API_TOKEN` | required for `http` | Argus bot API |
| `ARGUS_STATUS_URL` | | Separate status endpoint; the platform's `/api/health` works |
| `ARGUS_APP_URL` | `https://arkhonindustries.com/app` | Links in job embeds |
| `ARGUS_DB_PATH` | `./data/argus.sqlite` | Bot database |
| `ARGUS_TIMEZONE` | `America/Denver` | "Today" for dates |
| `ARGUS_WEBHOOK_SECRET` | | HMAC secret; webhook server off when blank |
| `ARGUS_WEBHOOK_HOST`, `ARGUS_WEBHOOK_PORT` | `0.0.0.0`, `8080` | Webhook listener |
| `ARGUS_EVENT_ROUTES` | | `event.type=channelId,...` for broadcast events |
| `ARGUS_STATUS_CHANNEL_ID` | | `#argus-status` |
| `ARGUS_STATUS_ROLE_ID` | | Pinged for degraded/outage only |
| `ARGUS_STATUS_POLL_SECONDS` | `60` | 0 disables polling |
| `ARGUS_STATUS_CONFIRMATIONS` | `2` | Polls that must agree before posting |
| `ARGUS_SUPPORT_CHANNEL_ID`, `ARGUS_STAFF_ROLE_ID` | | Enable support tickets (set both) |
| `ARGUS_TICKET_MODE` | `thread` | `thread` or `channel` |
| `ARGUS_TICKET_CATEGORY_ID` | | Category for ticket channels |
| `ARGUS_TICKET_ARCHIVE_CHANNEL_ID` | | Closed-ticket summaries |
| `ARGUS_SUPPORT_URL` | `https://arkhonindustries.com/contact` | Shown when tickets are off |
| `ARGUS_FAQ_PATH` | `bots/argus/faq.json` | FAQ file |
| `CERTA_DB_PATH` | | Certa bot database, read-only |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Connecting the real Argus API

The Argus platform does not expose a bot API yet. `docs/argus-backend-contract.md` lists every
endpoint, field, error code, and webhook event the bot expects. Until it ships, run with
`ARGUS_CLIENT=mock`, or point `ARGUS_STATUS_URL` at the existing health probe to get real status.

## Development

```bash
pnpm typecheck && pnpm test
```
