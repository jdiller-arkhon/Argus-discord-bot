# Arkhon Industries Discord bots: Argus

pnpm monorepo of TypeScript Discord bots (discord.js v14, Node 22, ESM). This repo holds the
Argus bot. The Certa bot (`jdiller-arkhon/Certa-discord-bot`) and the Ops bot
(`jdiller-arkhon/Arkhon-ops-bot`) live in their own repos with the same conventions.

```
packages/shared/   @arkhon/shared: helpers used by more than one bot, including the support ticket flow
bots/argus/        Argus bot: account link, status, event alerts, jobs, missions, payouts, credentials, help
docs/              Argus product context, the backend contract the bot depends on, and deploy.md
```

## Commands

```bash
pnpm install             # install everything
pnpm test                # vitest, all packages
pnpm typecheck           # tsc -b over sources and tests
pnpm build               # compile to dist/
pnpm argus:dev           # run the bot with tsx watch, reading ../../.env
pnpm argus:register      # register slash commands without starting the bot
pnpm argus:event <type> [--discord <id>]   # POST a signed sample event to the running bot
pnpm argus:mock-status <state> [summary]   # mock mode: change what the status endpoint reports
pnpm argus:doctor [--public-url <url>]      # check every credential and ID in .env; prints the invite link
docker compose up -d --build argus
pnpm deploy:cloudflare                      # production: Worker + container + D1 (CI does this); see docs/deploy.md
```

Run `pnpm typecheck && pnpm test` before committing.

## Conventions

- **ESM + NodeNext.** Relative imports use the `.js` extension (`import { x } from './x.js'`).
- **Config** is loaded once with `loadEnv(schema)` from `@arkhon/shared`, which validates
  `process.env` with zod and lists every bad variable at startup. Blank values count as unset.
  Every new variable goes into `.env.example` with a comment and into the README table.
- **Per-bot layout:**

  | Path | Contents |
  | --- | --- |
  | `src/index.ts` | Bootstrap |
  | `src/app.ts` | Wiring into a context object |
  | `src/config.ts` | Config schema |
  | `src/db.ts` | Migrations |
  | `src/store.ts` | SQL access |
  | `src/commands/*` | Subcommand factories taking the context |
  | `src/jobs.ts` | Scheduled jobs |

  Pure logic lives in its own modules (`events/routing.ts`, `status/monitor.ts`, `embeds.ts`) so it
  can be unit tested without Discord.
- **Commands** implement `SlashCommand`. Argus has one `/argus` command whose subcommands each
  implement `Subcommand` (`src/commands/types.ts`). Buttons, string selects and modals implement
  `ComponentHandler`, routed by `customId` prefix (`prefix:arg1:arg2`, max 100 chars, built with
  `customId()`). `createInteractionRouter` catches errors: throw `UserFacingError` for a friendly
  ephemeral message; anything else is logged and the user sees a generic failure.
- **Replies** that are personal (account data, errors) are ephemeral. Defer before any network
  call that can exceed Discord's 3 second window. `/argus status` is the only public reply.
- **Writes to Argus need a confirmation button.** Anything that changes data in Argus shows the
  details with Confirm/Cancel (or Save/Cancel) first and removes the buttons before calling the API
  (see `commands/missions.ts`). The writes are:
  - accepting a mission;
  - saving alert choices from `/argus alerts`;
  - posting a field step (`/argus step`);
  - changing duty (`/argus duty`);
  - unlinking.
- **Storage** goes through the async `SqlDb` interface (`packages/shared/src/sql.ts`): a SQLite file
  locally and in tests (`openSqliteDb`, `:memory:`), or Cloudflare D1 through the Worker when
  `D1_BRIDGE_URL` is set (`createD1BridgeDb`). Use `batch()` for writes that must apply together.
  Migrations are append-only, numbered from 1, tracked in `schema_migrations`, and must be valid
  on D1: one statement per `;`-terminated line, no `PRAGMA`. Never edit a shipped migration.
- **Outbound HTTP** goes through `request`/`requestJson` (per-attempt timeout, exponential
  backoff on 5xx/timeouts, no retry on 4xx). Wrap upstream data in zod schemas.
- **Inbound webhooks** verify `sha256=` HMAC signatures with `verifySignature` from
  `@arkhon/shared` against the raw body before parsing.
- **Logging** is JSON lines via `createLogger(botName)`. Log IDs, never tokens or message content.
- **Mentions:** the Argus client sets `allowedMentions: { parse: [] }`; opt in per message.
- **Shared code:** add to `packages/shared` only when two bots need it. The ticket flow
  (`tickets/`) and HMAC signatures (`signature.ts`) are there because the Ops bot has the
  same flow; port Ops onto them when the repos are merged.
- **No TODOs, stubs, or placeholder functions.** The mock client must keep every command working.
- **Tests** live in `<package>/test/*.test.ts`. Vitest resolves `@arkhon/shared` to its sources.

## Argus bot (`bots/argus`)

Argus is the platform behind the Arkhon drone-services marketplace (see
`docs/argus-product-context.md`). Clients request, get a quote, book, track, and approve drone jobs.
Verified pilots get alerts, accept missions, fly them, upload deliverables, and get paid. Many
pilots also use Certa, Arkhon's flight logbook, to log the flights they fly for Argus jobs.

### Commands

| Command | What it does |
| --- | --- |
| `/argus link code:<code>` | Redeems a one-time code from Argus (Settings → Discord). Notes a Certa link if one exists |
| `/argus unlink` | After Confirm, removes the link here and on Argus |
| `/argus status` | Current service health (public reply). The bot's presence mirrors it: "Watching the skies over the Pilot Network", or a 🟡/🛠️/🔴 custom status when Argus has trouble |
| `/argus today` | Today in the user's time zone: jobs, open missions, duty, pending payouts, documents (same view as the daily digest) |
| `/argus schedule` | The next 7 days of jobs grouped by day |
| `/argus jobs [scope]` | Client: bookings. Pilot: assigned jobs. Active or recently finished |
| `/argus job id:<n>` | One job: live step checklist, schedule, money, deliverables |
| `/argus missions` | Pilot: open missions; pick one → confirm → accept |
| `/argus earnings` | Pilot: pending, instant-payout-eligible, paid totals, recent payouts |
| `/argus credentials` | Pilot: verification, standing tier, credential status and expiry |
| `/argus stats` | Pilot: rating, latest reviews, paid this month/year, progress to the next standing tier |
| `/argus step job:<n> step:<step>` | Pilot: post a live field step (en route → uploading) after Confirm |
| `/argus duty [set]` | Pilot: check duty, or go on/off duty after Confirm |
| `/argus alerts` | Pick personal DM alerts (filtered to the account's role), then Save to Argus |
| `/argus help [topic]` | FAQ from `faq.json` plus "Open an Argus ticket" (or a support link) |

Account commands reply with `NOT_LINKED_MESSAGE` when the user is not linked. Pilot commands reply
with `PILOT_ONLY_MESSAGE` for client accounts.

### Why these product commands

- **`/argus jobs`**: the question both sides ask most is "where does my job stand?" The list
  shows status, today's live step, date and money for the jobs that are in flight, so clients stop
  emailing support and pilots see their schedule without opening the app.
- **`/argus job id:<n>`**: Argus already records each on-site step (en route → uploading) and the
  deliverables. Showing that checklist and the "approve to close" nudge is the live-tracking
  feature from the Argus site, inside Discord where pilots and clients already talk.
- **`/argus missions`**: pilots compete for jobs, and higher tiers see them first. A board in
  Discord, next to mission alerts, shortens the time from alert to acceptance. Accepting is the one
  write, so it requires a second, explicit Confirm click after the pilot reviews the details.
- **`/argus earnings`**: payout timing (held until client approval, instant payout eligibility)
  is the top pilot support topic. The view answers "when do I get paid" and flags failed payouts.
- **`/argus credentials`**: a lapsed Part 107 or insurance policy pauses standing and blocks
  missions. Showing expiry countdowns (🟡 within 30 days) before that happens keeps pilots
  eligible. Document numbers are never part of the response.
- **`/argus today`** (and the daily digest DM): one look at the day, so pilots don't have to open
  four commands. Built by Argus (`GET /today`) so the command and the digest always agree.
- **`/argus schedule`**: pilots plan their week around the calendar, not around a job list.
- **`/argus step`**: pilots are in the field with a phone and Discord open. Posting "on site" or
  "in flight" from there updates the client's live timeline with the same rules as the website.
- **`/argus duty`**: going off duty for a day shouldn't need the website.
- **`/argus stats`**: reviews and the gap to the next standing tier, which decides how early a pilot
  sees new missions.

When Argus answers `user_not_found` for a linked user (they unlinked on the website, or the account
was retired), `callArgus` removes the local link and tells them to link again.

### Argus API

Commands depend only on the `ArgusClient` interface (`src/argus/client.ts`).

- **`HttpArgusClient`:**
  - Uses `ARGUS_API_BASE_URL` plus bearer `ARGUS_API_TOKEN`, a 10s timeout per attempt, and 3 attempts with backoff (500ms, 1s) on 5xx and timeouts. POSTs carry an `Idempotency-Key`.
  - Errors map to `ArgusInvalidLinkCodeError`, `ArgusUserNotFoundError`, `ArgusNotFoundError`, `ArgusRejectedError`, `ArgusAuthError`, `ArgusUnavailableError`, and `ArgusResponseError`. `callArgus()` in `src/context.ts` turns them into user-facing messages.
  - `ARGUS_STATUS_URL` may point at the platform's existing `/api/health`. An unreachable status endpoint reports `outage` instead of throwing.
- **`MockArgusClient`** (`ARGUS_CLIENT=mock`) keeps its data in the bot's own SQLite `mock_*` tables.
  - Any well-formed code links once. Codes starting with `CLIENT` link a client, `ADMIN` an admin, anything else a pilot.
  - New accounts are seeded relative to today: a client gets jobs in progress, in review, pending, and completed; a pilot gets jobs, payouts, and credentials, with insurance expiring in 25 days.
  - The mission board refills when it runs empty.
- All request and response types are zod schemas in `src/argus/types.ts`. Unknown response keys
  are stripped.
- `docs/argus-backend-contract.md` is the contract. The platform implements it in
  `Arkhon-Industries` (`app/api/bot/v1`, `lib/platform/discord-bot/`), live on `main`.

### Event alerts

- `POST /webhooks/argus` (`src/webhook/server.ts`): HMAC-SHA256 `X-Argus-Signature`, verified
  on the raw body. Event ids are deduplicated in `processed_events` and the id is released if
  delivery throws, so Argus can retry. Unknown types get a 202.
- **Routing** is done by `routeEvent()` in `src/events/routing.ts`, which is pure:
  - `service.status_changed` goes to the status monitor.
  - `account.test` (the website's "Send a test DM") is always DMed, ignoring every setting.
  - `digest.daily` is DMed and respects quiet hours, but it can't be muted with `/argus alerts`; the user turns it off on the website.
  - An event with a `userId` is DMed to the linked owner unless they muted that type. It is never posted to a channel, because it is about their jobs, money, or credentials.
  - A broadcast (`userId: null`) goes to the `ARGUS_EVENT_ROUTES` channel for its type, or is dropped.
- **Bot settings live on Argus**, not in the bot. Users edit them in the pilot portal (Arkhon
  website → Pilot Network: `/app/pilot/discord`, and `/app/admin/discord` while the rollout is admins only) and with `/argus alerts`. They are read with
  `ArgusClient.getBotSettings` through `src/settings.ts`, which caches them for 60s and falls back to
  defaults if Argus is unreachable, so alerts keep flowing.
  - `disabledAlerts`: alert types turned off. New types default to on.
  - `missionAlerts`: minimum payout and maximum distance for `mission.posted` DMs. Missions with an unknown distance still pass.
  - `timezone`: the user's zone, used for quiet hours, `/argus schedule`, and the digest.
  - `missionAlerts.serviceTypes`: service ids to DM missions for. An empty list means every service.
  - `digest`: `{ enabled, hour, skipEmpty }`. Argus sends `digest.daily` from its hourly job-alerts sweep, so no extra GitHub Actions minutes are used.
  - `quietHours`: start, end, and `allowUrgent`. Overnight ranges and DST are handled. During quiet hours, DMs are held in `held_dms` and sent by `startHeldDmDelivery` (every minute) once quiet hours end. `payout.failed` and `dispute.updated` skip the hold when `allowUrgent` is on.
- `alertsForRole()` limits the alerts menu to alerts that apply to the account. `/argus alerts`
  previews a selection and saves it only on **Save**; the Save button carries the choice as a
  bitmask, and saving re-reads the settings so filters and quiet hours set on the website are kept.

### Service status

- `StatusMonitor` (`src/status/monitor.ts`) takes observations from polling
  (`ARGUS_STATUS_POLL_SECONDS`) and from `service.status_changed` webhooks.
- A polled change must be seen `ARGUS_STATUS_CONFIRMATIONS` times in a row before it is
  announced. Webhook changes apply immediately. The first observation is recorded silently.
- Changes post to `ARGUS_STATUS_CHANNEL_ID`. `ARGUS_STATUS_ROLE_ID` is pinged only when the new
  state is `degraded` or `outage`.
- The announced state lives in `status_state`, so restarts do not re-announce. A failed post
  leaves memory unchanged and the change is announced on the next observation.

### Support handoff

- `faq.json` (override with `ARGUS_FAQ_PATH`) is validated at startup: 1–25 entries with unique
  slugs, and questions of at most 100 characters because they double as `/argus help topic` choices.
- With `ARGUS_SUPPORT_CHANNEL_ID` and `ARGUS_STAFF_ROLE_ID` set, `/argus help` shows the shared
  ticket flow's button (`createTicketFlow` in `packages/shared/src/tickets/flow.ts`, ported from
  the Ops bot):
  - A modal asks for subject, description, and an optional job ID.
  - The ticket opens as a private thread in the support channel, falling back to a private channel.
  - Staff get Claim, Waiting on user, and Close buttons. A reply from the user reopens a ticket that is waiting on them.
  - Closing posts a summary to `ARGUS_TICKET_ARCHIVE_CHANNEL_ID` and DMs the user.
- Without those settings, the button links to `ARGUS_SUPPORT_URL`.

### Data rules

- The bot DB holds Discord ID, Argus user ID, display name, role, processed event IDs, DMs held
  for quiet hours (deleted on delivery or unlink), status memory, and tickets. Alert settings are on Argus. **Never store** addresses, coordinates, payment details,
  emails, or certificate, policy, or registration numbers.
- Places are shown as `locality` ("City, ST") only.
- The Certa link check (`CERTA_DB_PATH`) opens the Certa bot's database read-only per lookup and
  reads only `links.display_name`.

## Testing rules

- Pure logic is unit tested without Discord: routing, preference filtering, status debounce,
  signatures, ticket state, config, and every product command's formatting (`test/formatting.test.ts`).
- `test/commands.test.ts` drives the real router with fake interactions and the mock client, end to end.
- HTTP code is tested with a fake `fetch`; the webhook server is started on port 0 with fake deps.
- Tests never need real tokens, network access, or a database file (`:memory:`).
