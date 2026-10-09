# Argus product context

Drafted from `jdiller-arkhon/Arkhon-Industries` (the Next.js platform on Cloudflare Workers at arkhonindustries.com).
Main sources: `app/(site)/argus/page.tsx`, `lib/db/schema.ts`, `lib/platform/*`, `app/api/*`.

## What Argus is
Argus is the platform behind the Arkhon drone-services marketplace. Clients use it to request, quote, book,
track and approve drone jobs. Verified pilots get alerts for those jobs, take them, fly them and get paid.
Admins verify pilots and handle disputes. Flow: Request → Instant quote → Dispatch → Deliver.

## Who uses it
- **Clients:** solo accounts or teams. They book jobs and approve deliverables.
- **Pilots:** they hold FAA Part 107 plus insurance, ID and drone registration. Standing tiers run
  verified → established → trusted → elite, and higher tiers see new jobs sooner.
- **Admins:** pilot verification, disputes, payouts.

## Data it holds
- **Quotes:** service, address, acreage, urgency (standard/priority/rush), deliverables, itemized total.
- **Projects (jobs):** status is `awaiting_payment | pending | scheduled | in_progress | review | completed | cancelled | needs_review`.
  Each has a payment status, scheduled date and time window, image count and amount.
- **Missions:** the pilot-facing side of a project. Status is `open | accepted | declined | completed`, plus payout and distance.
- **Live job steps:** `en_route | on_site | preflight | airspace_cleared | in_flight | landed | uploading`.
- **Deliverables:** image / video / map / report.
- **Pilot credentials:** `faa_part107 | insurance | id | drone_reg`, each with status and expiry.
  Also stored: pilot verification status, rating, completed flights, standing tier.
- **Payments:** Stripe and Stripe Connect payouts, including instant payouts. Also invoices, disputes, support tickets.
- **Notifications:** `flight_request | pilot_approval | payment_issue | payout_failed | dispute | job_cancelled | job_review | system`,
  with severity `info | success | warning | critical`.

## Events it generates
Today these go out by email, push and in-app notification, driven by crons in `app/api/cron/*`:
- new mission alerts to pilots
- job status changes and live job steps
- review reminders
- unclaimed-job notices (48h)
- credential expiry reminders
- payout failures
- disputes
- job cancellations

## API / webhooks today
**There is no external API or outbound webhook for third parties.** What exists:
- `GET /api/health`: public, returns `{ ok, db }` with 200 or 503, rate limited.
- An inbound Stripe webhook.
- Internal session-authenticated routes.

The Discord bot's `ArgusClient` contract therefore has to be added to the platform:
- link-code redemption
- read endpoints for jobs, missions, earnings and credentials
- an HMAC-signed outbound event webhook

## How pilots use it alongside Certa
Certa is Arkhon's flight operations and compliance logbook. A pilot finds and flies paid jobs through Argus,
then logs those flights and tracks Part 107 currency in Certa. Both products verify the same Part 107 credential.
