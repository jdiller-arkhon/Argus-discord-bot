# What the Argus platform must expose for the bot

The bot talks to Argus only through `ArgusClient` (`bots/argus/src/argus/client.ts`). The platform
side of this contract is implemented in the `Arkhon-Industries` repo on branch
`claude/discord-bot-api`:

| Piece | Where |
| --- | --- |
| Routes | `app/api/bot/v1/**` |
| Logic | `lib/platform/discord-bot/` |
| Website mission rules, shared by the bot | `lib/platform/mission-claim.ts` |
| Link codes | Settings → Discord |
| Bot settings dashboard | Pilot portal → Discord Bot (`/app/pilot/discord`) |
| Migration | `drizzle/add-discord-bot.sql`. It's safe to deploy before applying it: Discord reads degrade to "not linked". Apply it to turn the feature on. |

The platform needs these environment variables:

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_API_TOKEN` | Same value as the bot's `ARGUS_API_TOKEN` |
| `DISCORD_BOT_WEBHOOK_URL` | The bot's `https://…/webhooks/argus` |
| `DISCORD_BOT_WEBHOOK_SECRET` | Same value as the bot's `ARGUS_WEBHOOK_SECRET` |

Point the bot's `ARGUS_API_BASE_URL` at `https://arkhonindustries.com/api/bot`. The zod schemas in `bots/argus/src/argus/types.ts` and
`bots/argus/src/events/types.ts` are the source of truth for every field.

## Conventions

- Base URL: `ARGUS_API_BASE_URL` = `https://arkhonindustries.com/api/bot` (routes live under `/api/bot/v1`).
- Auth: `Authorization: Bearer <ARGUS_API_TOKEN>`. This is a single bot service token, not a user session.
  Every `/v1/users/:argusUserId/...` route must check that the user exists and act as that user,
  using the same scoping as the web app (`clientProjectScope()` for clients, assignment for pilots).
- POSTs carry `Idempotency-Key: <uuid>`. The bot retries 5xx up to 3 times, so repeat keys must
  return the original result.
- Errors use a JSON body `{ "code"?: string, "message"?: string }`. `message` may be shown to the user.

| Status | Meaning to the bot |
| --- | --- |
| 401 | Bad bot token. Logged as a misconfiguration. |
| 403 with `code: "not_allowed"` | This user may not do this (e.g. a client asking for earnings). `message` is shown. Any other 403 is treated like 401. |
| 404 / 410 | On link redeem: invalid, expired or used code. On `/users/:id/...` list routes: user gone. On a job or mission route: not found or not theirs, unless `code: "user_not_found"`. |
| 400 / 409 / 422 | Refused. `message` is shown, e.g. "Another pilot accepted this mission first." |
| 5xx | Retried with 500 ms and 1 s backoff, then "Argus is not responding". |

Titles are built at booking as `"<street address> · <service>"`, so the platform passes every title through `botTitle()`, which swaps the address for the locality.

**Never include** street addresses, coordinates, emails, phone numbers, payment details, or
certificate, policy, or registration numbers. The schemas strip unknown keys, but the API should not
send these in the first place. Use `locality` ("City, ST") for places.

## Endpoints

### `POST /v1/discord/link-codes/redeem`

Body `{ code, discordUserId }`, response `{ argusUserId, displayName, role }`. `role` is `client`,
`pilot`, or `admin`, from `user.role`.

**Settings → Discord** (and the pilot portal's Discord Bot page) issues one-time codes. Codes should be single-use,
expire in about 10 minutes, and be 6–32 characters of `A-Z 0-9 -`. Redeeming stores the
Discord ID on the user so that events can carry `userId`.

### `GET /v1/users/:id/settings` and `PUT /v1/users/:id/settings`

The user's bot settings, as one document. Users edit it in the pilot portal (Discord Bot page) and with
`/argus alerts`. The bot enforces it when delivering events.

| Field | Values |
| --- | --- |
| `disabledAlerts` | Personal alert types turned off. Anything not listed is on. |
| `missionAlerts` | `{ minPayoutCents, maxDistanceMi, serviceTypes }`. The limits are `null` for no limit; an empty `serviceTypes` means every service. |
| `timezone` | The user's IANA time zone |
| `quietHours` | `{ enabled, start: "HH:mm", end: "HH:mm", allowUrgent }` |
| `digest` | `{ enabled, hour: 0-23, skipEmpty }` |

`PUT` validates with the same rules as the website form and returns 422 `invalid_settings` with a
message on bad input.

### Pilot tools

| Route | Who | What |
| --- | --- | --- |
| `GET /v1/users/:id/today` | all | Today's summary in the user's settings time zone. The `TodaySummary` shape is also the `digest.daily` event data. |
| `GET /v1/users/:id/stats` | pilots | `PilotStats`: work done, paid this month and year, rating, last 3 reviews, next-tier requirement rows. |
| `GET /v1/users/:id/duty` and `PUT /v1/users/:id/duty` | pilots | `{ onDuty }`. Going on duty uses the website switch's rule: credentials must be verified and current. |
| `POST /v1/users/:id/jobs/:jobId/steps` | pilots | `{ step, note }` → `{ jobId, step, at }`. Same rules and client notifications as the website's live status. Not the job's pilot → 404. |
| `DELETE /v1/users/:id/link` | all | Unlinks Discord on Argus. |

### `GET /v1/status`

Response `{ state, summary, components: [{ name, state }], updatedAt }`, where `state` is one of
`operational | maintenance | degraded | outage`.

The platform answers with the same database check as `/api/health`. Alternatively, set
`ARGUS_STATUS_URL=https://arkhonindustries.com/api/health`; the bot maps `{ ok: true }` to
operational and anything else (including a 503 or a timeout) to outage.

### `GET /v1/users/:id/jobs?scope=active|recent`

Response `{ jobs: JobSummary[] }`, at most 10 jobs.

- `active` covers these `projects.status` values: `awaiting_payment`, `pending`, `scheduled`, `in_progress`, `review`, `needs_review`.
- `recent` covers the rest, newest first.
- A client sees projects they own, and their team's projects. A pilot sees projects where they are `pilotId`.

`JobSummary` fields:

- `id`, `title`, `serviceType`, `status`, `paymentStatus`
- `scheduledFor` (YYYY-MM-DD) and `timeWindow`
- `amountCents`: the price for clients, the mission payout for pilots
- `locality`
- `viewerRole`
- `counterpartName`: the pilot's display name for a client, the client's for a pilot
- `latestStep`: the newest `job_status_updates.step`

### `GET /v1/users/:id/jobs/:jobId`

Response: `JobSummary` plus these fields:

- `imageCount`
- `addOns`: `DELIVERABLE_OPTIONS` ids
- `steps: [{ step, at }]`, from `job_status_updates`
- `deliverables: [{ name, kind, imageCount }]`
- `createdAt`

Return 404 if the job is not the user's.

### `GET /v1/users/:id/missions/open`

Response `{ canAccept, tier, missions: OpenMission[] }`, pilots only (403 `not_allowed` for others).

- **Which missions:** open missions whose tier visibility window is open for this pilot (`tierWindowOpen()` in `lib/platform/job-alerts.ts`) and whose service area covers the site. At most 25.
- **`canAccept`:** whether the pilot can accept right now. It should be false while verification is incomplete or standing is paused.
- **`OpenMission` fields:** `id`, `title`, `serviceType`, `locality`, `distanceMi`, `payoutCents`, `scheduledFor`, `timeWindow`, `imageCount`, `addOns`, `postedAt`.

### `POST /v1/users/:id/missions/:missionId/accept`

This is the bot's only write. The user confirms with a button before it is sent.

- **Response:** `{ missionId, jobId, title, scheduledFor }`.
- **Claim logic:** must use the same atomic claim as `acceptMission` in the web app, including the on-demand flight-insurance requirement.
- **Refusals:** 409 with a message if another pilot won, 403 `not_allowed` if the pilot cannot accept.

### `GET /v1/users/:id/earnings`

Response fields, pilots only:

- `pendingCents`: payouts held until the client approves, plus payouts not yet sent.
- `availableCents`: the amount eligible for an instant payout.
- `paidLast30DaysCents` and `paidYearToDateCents`.
- `completedMissions`.
- `recentPayouts: [{ id, missionTitle, amountCents, status, date }]`, the last 5, where `status` is `pending | in_transit | paid | failed`.

### `GET /v1/users/:id/credentials`

Response fields, pilots only:

- `verificationStatus`: from `pilot_profiles`.
- `standingTier` and `paused`: from `pilot_standing`.
- `credentials: [{ kind, status, expiresAt, insuranceMode }]`, one per `faa_part107 | insurance | id | drone_reg`. Use `status: "missing"` when nothing has been uploaded.

## Outbound events: `POST <bot>/webhooks/argus`

Argus sends events to the bot's public URL (behind TLS).

**Signing.** Each request carries `X-Argus-Signature: sha256=<hex HMAC-SHA256 of the raw body>`,
keyed with `ARGUS_WEBHOOK_SECRET`. Sign the exact bytes you send.

**Envelope.** Every event looks like this:

```json
{ "id": "evt_…", "type": "job.step", "occurredAt": "2026-10-10T15:20:00Z", "userId": "argus user id or null", "data": { } }
```

**Delivery:**

- **`id`** is unique per event. Reuse it when retrying; the bot ignores ids it has already handled for 30 days.
- **`userId`** names the Argus user the event is about. The bot DMs that user if they are linked and have not muted the type. Events with a `userId` are never posted to a channel.
- **Broadcasts** (`userId: null`) go to the channel set in `ARGUS_EVENT_ROUTES`.
- **Responses:**
  - **200:** handled or duplicate.
  - **202:** unknown type, so new types can ship before the bot knows them.
  - **400:** bad payload.
  - **401:** bad signature.
  - **503:** bot not connected yet. Retry.
  - **500:** delivery failed. Retry with the same `id`.

| Type | `data` | Emitted when (platform hook) |
| --- | --- | --- |
| `service.status_changed` | full `/v1/status` body | status changes (manual or health monitor) |
| `mission.posted` | `missionId, title, serviceType, serviceId, locality, distanceMi, payoutCents, scheduledFor` | job alert sweep, once per alerted pilot (`userId` set) and optionally once as a broadcast |
| `job.status_changed` | `jobId, title, from, to` | any `projects.status` change; send to the client and to the assigned pilot |
| `job.step` | `jobId, title, step, note` | a pilot posts a `job_status_updates` step; send to the client |
| `job.deliverables_ready` | `jobId, title, deliverableCount` | job enters `review` |
| `payout.paid` / `payout.failed` | `payoutId, amountCents, missionTitle` / `reason` | Stripe Connect transfer and payout webhooks |
| `credential.expiring` | `kind, expiresAt, daysRemaining` | `credential-expiry` cron ladder |
| `credential.reviewed` | `kind, status, note` | admin approves or rejects a credential |
| `dispute.updated` | `disputeId, jobId, status, resolution` | dispute opened or changed; send to client and pilot |
| `account.test` | `requestedAt` | "Send a test DM" on the pilot portal's Discord Bot page |
| `digest.daily` | `TodaySummary` | the hourly job-alerts sweep, once per local day at the user's chosen hour |

Use `pnpm argus:event <type> --discord <id>` to send correctly signed samples of each type to a
local bot.
