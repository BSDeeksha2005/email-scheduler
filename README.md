# Email Scheduler — ReachInbox Assignment

Production-grade-ish email scheduler service + dashboard. Built under a hard
time constraint — see **Trade-offs** at the bottom for exactly what was cut
and why, as requested in the assignment.

## Stack

- Backend: Node.js, TypeScript, Express
- Queue: BullMQ, backed by Redis (no cron, per the constraint)
- DB: PostgreSQL
- SMTP: Ethereal (fake SMTP, auto-creates a test account on boot if you don't
  supply one)
- Frontend: a single static HTML/JS page (no build step — see trade-offs)

## How to run

### 1. Start Redis + Postgres

```bash
docker-compose up -d
```

### 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

This will:
- create the `emails` table if it doesn't exist
- **rehydrate** any rows still in `scheduled` status into BullMQ delayed jobs
  (this is what makes restarts safe — see Architecture below)
- start the BullMQ worker in-process
- listen on `http://localhost:4000`

### 3. Frontend

Just open `frontend/index.html` in a browser (or `npx serve frontend`). It
talks to `http://localhost:4000/api/emails`.

## Architecture

### How scheduling works
`POST /api/emails/schedule` writes a row to Postgres first, then calls
`scheduleEmailJob()`, which adds a BullMQ **delayed job** using the DB row's
own UUID as the BullMQ `jobId`. The delay is computed as
`scheduledAt - now`. No cron, no polling loop — BullMQ/Redis itself fires the
job at the right time.

### How persistence on restart is handled
On every boot, `rehydrateScheduledJobs()` (in `src/index.ts`) queries Postgres
for every row still in `status = 'scheduled'` and re-adds each one via
`scheduleEmailJob()`.

This is safe and **idempotent** because `scheduleEmailJob()` always uses the
DB row's `id` as the BullMQ `jobId`, and BullMQ refuses to create a second
job with a `jobId` that's already waiting/delayed/active. So:
- If Redis data survived the restart (the common case), re-adding is a no-op
  — the original job is still there, untouched.
- If Redis was flushed (edge case, e.g. fresh container), the re-add
  recreates the job with the correct remaining delay (or fires it almost
  immediately if the scheduled time already passed while the server was
  down).

Either way: **exactly one job per email, never duplicated, never lost.**

### How rate limiting & concurrency are implemented
- **Concurrency**: the BullMQ `Worker` is created with a configurable
  `concurrency` option (`WORKER_CONCURRENCY` env var).
- **Minimum delay between sends**: enforced via BullMQ's built-in worker
  `limiter` option (`max: 1` per `MIN_DELAY_MS_BETWEEN_SENDS`). This is a
  **global** pacing limit across all senders, not per-sender — see
  trade-offs.
- **Hourly rate limit**: `src/rateLimiter.ts` uses a Redis `INCR` +
  `EXPIRE` counter keyed by `sender + hour-window` (`rate:<sender>:<ISO
  hour>`), so it's safe across multiple worker processes/instances — no
  in-memory counters.
- **When the limit is hit**: the job is **not** dropped or failed. Inside the
  processor, we call `job.moveToDelayed(nextHourWindowStart, token)` and
  throw a sentinel error that the `failed` handler recognizes and ignores.
  The job re-enters the delayed queue and is retried automatically once the
  next hour window opens.

## Features implemented

**Backend**: scheduler (BullMQ delayed jobs), Postgres persistence +
restart-safe rehydration, idempotent job IDs, per-sender hourly rate limiting
(Redis-backed), configurable worker concurrency, minimum delay between
sends, CSV/text lead-parsing endpoint (count + email extraction).

**Frontend**: compose/schedule form, scheduled-emails table, sent-emails
table, basic empty states, polling refresh.

## Trade-offs, shortcuts, and what's missing (honest list)

Given a 2-hour build window against a spec designed for a much longer
timeline, the following were deliberately cut. Each is something I'd add
next if given more time:

- **No Google OAuth / login.** The dashboard is unauthenticated. All requests
  are treated as a single implicit user.
- **No Slack integration.** The spec's rate-limit Slack notification (OAuth
  connect flow + live message on hourly-limit hit) is not implemented at
  all. This is the single biggest scope cut.
- **No Elasticsearch.** Sent/scheduled emails are just queried from Postgres,
  not indexed into Elasticsearch as the spec asks.
- **Frontend is a single static HTML/JS file, not React/Next + Tailwind, and
  does not attempt to match the provided Figma.** It's functional (schedule,
  view scheduled, view sent) but not the polished, componentized frontend
  the spec describes.
- **Bulk CSV upload only counts/parses emails; it doesn't wire directly into
  bulk-scheduling multiple jobs in one request.** The endpoint
  (`POST /api/emails/parse-leads`) returns the parsed list; looping that
  through `/schedule` per-address is left as a follow-up.
- **Rate-limiting minimum delay-between-sends is global, not per-sender.**
  The hourly cap *is* correctly per-sender (Redis key includes sender), but
  the BullMQ worker `limiter` pacing option applies queue-wide. A fully
  correct per-sender pacing implementation would need per-sender sub-queues
  or a custom token-bucket check inside the processor.
- **No load-testing of the "1000+ emails at once" scenario** was actually
  run, though the rate-limiter + reschedule-on-limit logic is written to
  handle it (jobs get pushed to the next hour window rather than failing).
- **No automated tests.**
- **Worker runs in the same process as the API server**, rather than as a
  separately deployable process — fine at this scale, documented as a
  simplification.

## Demo checklist (what to show if recording)

1. Schedule an email a few seconds/minutes out via the dashboard.
2. Show it appear in "Scheduled Emails".
3. Wait for send, show it move to "Sent Emails" (check the Ethereal inbox
   link logged in the backend console for the actual test email).
4. Restart scenario: stop the backend (`Ctrl+C`), start it again
   (`npm run dev`), point out the `[boot] rehydrated N scheduled job(s)`
   log line, and show a still-pending scheduled email still fires on time.
