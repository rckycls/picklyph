# Monitoring and operator alerts (T51a)

The backend checks itself every five minutes and posts to the operators' Discord channel when
something breaks. It posts again every six hours while the problem lasts, and once when it clears.
Paging is not part of this. T51b added the storage sweep's job and backlog check; T51c added the
console's [System health](#console-system-health-t51c) page; T51d added
[mobile crash reports](#mobile-crash-reports-t51d) and the `app.crashes` check.

```
Edge functions ──5xx / 503 / limiter outage──▶ ops_signal_record ──▶ private.ops_signals
pg_cron "ops-monitor" (*/5) ─▶ private.ops_monitor_kick ─▶ pg_net POST (Vault URL + secret)
  ─▶ ops-monitor function ─▶ Redis checks ─▶ ops_monitor_run (checks + alert state)
  ─▶ one Discord message ─▶ ops_alerts_confirm ─▶ heartbeat ping (optional)
```

## What is checked

Every check has a fixed name and carries a **count only**: never IDs, names, emails or secret
values, because alerts leave the system. Thresholds are in the migration
(`20261011120000_ops_monitoring.sql`; T51b's `20261012090000_storage_sweep.sql` holds the current
`private.ops_health`), so changing one is one migration.

| Check | Warn / fail | Means | First look |
| --- | --- | --- | --- |
| `cron.jobs` | fail at 1 | One of `booking-expiry-sweep`, `push-dispatch`, `privacy-retention-sweep`, `ops-monitor`, `storage-sweep` is missing or inactive (all five when pg_cron is off) | `select jobname, active from cron.job` |
| `cron.failures` | 1 / 3 | Failed runs of those jobs in the last 15 minutes | `cron.job_run_details` `return_message` (e.g. push `not_configured` = Vault secrets missing) |
| `cron.stalled` | fail at 1 | An every-minute job (`booking-expiry-sweep`, `push-dispatch`) has not succeeded in 10 minutes | the job's schedule; pg_cron worker running |
| `holds.overdue` | fail at 1 | Rental or group holds elapsed over 10 minutes ago but still pending. Reads already treat them as expired, so this means the sweep is not running, not that inventory is wrong | `booking-expiry-sweep` |
| `inventory.mismatch` | fail at 1 | A confirmed rental without its firm court, a finished one still holding it, rental/session inventory with no booking or session, a session's `reserved_spots` that differs from its live groups, or session courts out of step with the session (rows ending within the last two days or later) | stop and investigate before more bookings: this should be impossible |
| `push.backlog` | fail at 1 | Outbox rows due, or leases expired, over 10 minutes ago | `push-dispatch` job, Vault `push_*`, worker secret |
| `push.failures` | 1 / 10 | Rows failed in the last hour (retries exhausted, too big, invalid payload) or failed receipts in the last two hours (`DeviceNotRegistered` excluded) | `notification_outbox.last_error` |
| `push.credentials` | fail at 1 | Expo refused for credentials (`invalid_credentials`, `mismatch_sender_id`, `expo_rejected`): every push will fail | APNs key in EAS credentials, `EXPO_ACCESS_TOKEN` |
| `edge.errors` | 1 / 5 | Function 5xx other than 503 (or a throw) in the last 15 minutes | function logs in the Supabase dashboard |
| `edge.unavailable` | 5 / 25 | 503 answers in the last 15 minutes (outage policy or a dependency down) | usually with `edge.limiter` or a database incident |
| `edge.limiter` | fail at 1 | The rate guard ran under its outage policy: new holds/submissions are refused, discovery runs unthrottled | Upstash status and the function secrets |
| `redis.reachable` | fail | The monitor could not ping Redis with this environment's settings (or they are missing/invalid) | `UPSTASH_REDIS_REST_*`, `RATE_LIMIT_KEY_SECRET`, `PICKLY_ENV` |
| `redis.isolation` | fail at 1 | Another environment's marker is in this Redis database: two environments share it (H02 requires separate databases) | give each environment its own database |
| `privacy.deletions` | fail at 1 | An account deletion started over an hour ago and its Auth user still exists (storage or Auth step failed) | `account-deletion` logs; the user retries, or an operator finishes it |
| `storage.backlog` | 1 / 25 | Files the daily storage sweep should have removed over a day ago: proof photos 31+ days after their decision, unreferenced objects 48+ hours old (T51b) | the `storage-sweep` job, Vault `storage_sweep_*`, the function's 502 `storage_refused` replies in `net._http_response` ([privacy](privacy.md#storage-cleanup-t51b)) |
| `app.crashes` | 1 / 10 | App crashes and failed screens reported by preview and production builds in the last hour (development builds never count; T51d, migration `20261014090000_crash_reports.sql`) | the console's System health page, **App crashes** ([below](#mobile-crash-reports-t51d)) |
| `rollout.arrival_only` | fail at 1 | An active merchant, a stored online/both policy, or a live booking snapshot offering online payment during the pay-on-arrival pilot | **replace this check when online payments resume** |

The Redis checks run in the function: it pings with the same settings as the rate guard
(`readUpstashConfig`), writes `pickly:<env>:ops:environment` (two-day expiry) and counts the other
environments' markers. When Redis is down, isolation is left out of that run and keeps its last
state.

## Edge signals

`_shared/ops.ts` wraps every function entrypoint except `ops-monitor`:
`observeHandler` (`storage-sweep` included since T51b) notes 503 as `unavailable` and other 5xx (or a throw) as `server_error`;
`observeGuard` notes each rate-guard decision made under the outage policy as `limiter_degraded`.
The reporter writes at most once per kind per minute per isolate through `ops_signal_record`
(service-only, fixed sources and kinds, 1–10000). The first signal after a quiet minute is written
at once and later ones ride along with the next write. Writes go to the background
(`EdgeRuntime.waitUntil`) and never change or delay the answer; a failed write is dropped. Monitor
runs delete signals older than two days.

## Alerts

`ops_monitor_run` keeps one row per check in `private.ops_alert_state` (status, count, since, what
was last posted). An alert is due when a check differs from what was last posted (into warn or
fail, between them, or back to ok), or has stayed in warn/fail for six hours since the last post.
Nothing is marked posted until Discord accepted the message (`ops_alerts_confirm`), so a failed post
is sent again on the next run. A check that changed again between the run and the confirmation is
left for the next run. Runs take an advisory lock, so overlapping runs never lose a change. If
Discord accepted a post but the confirmation was lost, the next run posts it again (a rare
duplicate).

One message per run, problems first:

```
**PicklyPH staging** monitor: 3 problems, 1 resolved
🔴 FAIL (was WARN) · Scheduled job runs: 3 failed runs in the last 15 minutes
🔴 STILL FAILING since Oct 11, 6:05 PM (Manila) · Redis: not reachable or not configured from the monitor
🟡 WARN · Edge functions: 3 server errors in the last 15 minutes
✅ RESOLVED · Hold sweep
```

The webhook post sets `allowed_mentions.parse: []` (no pings), `?wait=true`, and refuses redirects.
The function answers 200 with `{ checks: [{ check, status, count }], alerts }`, 502
`delivery_failed` when Discord refused, 503 when the database is unreachable, 401 for anything but
the worker secret and 503 `not_configured` without a secret or a valid webhook. A manual run with the
secret (`curl -X POST -H "Authorization: Bearer <secret>" <url>`, never pasted anywhere) is safe at
any time.

**Who watches the monitor.** A database outage or a stopped pg_cron worker also stops the monitor.
Set the optional `OPS_HEARTBEAT_URL` to an outside dead-man's switch (for example a free
healthchecks.io check expecting a ping every five minutes, with a grace period); the function pings
it after every completed run (nothing due, or Discord accepted the post), so missing pings alert by
the outside service's own channel.

## Console System health (T51c)

Administrators open **System health** in the console (`/console/health`; moderators and players are
refused, and the database rechecks the role). One service-only read, `ops_admin_read(actor)`
(migration `20261013210000_ops_console.sql`), writes nothing and returns:

- **Checks now:** `private.ops_health` evaluated on page load, the same SQL the monitor runs, so the
  page works where the monitor is not set up yet. The two Redis checks show the monitor's last result
  only. Without pg_cron, `cron.failures` and `cron.stalled` are not checked and say so.
- **What the monitor saw and posted:** each check's stored status, since when, when a run last
  checked it (`ops_alert_state.checked_at`, stamped by `ops_monitor_run` since T51c; null for rows
  from before) and what the channel was last told, or "Not posted yet".
- **Monitor freshness:** the latest stamp. Over 15 minutes old (three missed runs) the page and the
  Overview card say the monitor stopped; with no stamp at all they say it never ran.
- **Scheduled jobs:** the five expected jobs (the active row of a name): present, active, schedule
  (UTC), the last run and its status, the last success and failed runs in the last 24 hours, and the
  latest failure's pg_cron message cut to 300 characters. Null ("pg_cron is off") without pg_cron.
  It reads only the last day of `cron.job_run_details`, which pg_cron never trims by itself.
- **Edge signals:** per function and kind, the counts for 15 minutes, an hour and 24 hours (capped at
  1,000,000 like the checks) and the last minute seen.

Counts, job names, schedules and pg_cron messages only. **Check again** reloads the page; there are no
buttons that run the monitor, post or change anything. The Overview shows administrators a **Health
problems** card (live problems plus the monitor's Redis results) with the monitor's freshness.

**Staging (2026-10-14):** the migration is applied. The monitor is not set up there yet, so the page says
no monitor run is recorded and shows its own live checks.

## Mobile crash reports (T51d)

In-house and anonymous: no third-party service, account or native module.

```
app error ─▶ global handler / root boundary ─▶ scrubbed report ─▶ device queue (AsyncStorage)
  ─▶ POST crash-reports (public key only) ─▶ crash_report_record ─▶ private.app_crashes
  ─▶ app.crashes check (monitor, Discord) · crash_admin_read (console, System health)
```

**On the phone** (`src/features/crash/`, installed in `src/app/_layout.tsx`):

- A global handler records every error React Native's own handler sees (`fatal` or `error`), then
  hands it on unchanged. A fatal error is passed on only after its report is saved, or after 1.5
  seconds, because React Native ends the app right after.
- A root boundary records render errors (`render`) with React's component stack and shows
  "Something went wrong" with **Try again**, which remounts the app below it.
- A report holds the error name, message and stack, the component stack (render only), the screen's
  path with IDs replaced (`/rental/booking/[id]`), the app version, the build variant (`APP_VARIANT`
  through `extra.variant`), the OS and its version, and the time. Text is cut to fixed limits and
  scrubbed of emails, phone-like numbers (10+ digits), UUIDs, JWTs, `Bearer` values, Supabase keys,
  Expo push tokens, IP addresses and URL query strings (`scrubCrashText` in the domain `crash.ts`).
  No account, device ID or token is sent; the request carries only the public key.
- The queue keeps at most 10 reports for at most 7 days. It sends at launch (after 3 seconds), on every
  return to the foreground and right after a non-fatal error. A 2xx answer, or a 400, 413 or 415 refusal,
  removes the report; anything else (no answer, 429, 5xx, a function not deployed yet) keeps it for the
  next try. The same error (kind, name, message) is recorded once a minute.

**On the server:** `crash-reports` accepts POST JSON up to 16 KiB, reads no bearer, parses and scrubs
again, limits by the trusted ingress source (`crash-report`, 20 a minute per source; all guests share
one bucket until `DISCOVERY_IP_SOURCE=cloudflare`) and keeps accepting in a Redis outage (reports touch no
bookings or payments; `edge.limiter` still alerts). It computes the grouping fingerprint (kind, name,
message with numbers blanked, first five stack frames or three components) and stores through the
service-only `crash_report_record`: one row per report ID (a resend is recognised), at most 2,000 stored a
day. The daily privacy sweep removes reports after 30 days ([privacy](privacy.md#what-is-kept-and-for-how-long)).

**Console:** System health's **App crashes** section (admins only; `crash_admin_read` rechecks the role
and writes nothing) lists the last 7 days grouped by fingerprint, at most 50 groups, most recently seen
first: kind, name and message, reports per build variant, the latest version, OS and screen, first and
last seen, and the latest stack. Red badges mark groups that count toward `app.crashes`.

**Limits:** crashes in native code that never reach JavaScript are not reported; release stacks are
minified (no symbolication, so a new build starts new groups); unhandled promise rejections are not
captured. The iPhone check needs a build with this JavaScript: a development build after a Metro reload
reports as `development` (listed, never alerting); preview builds report as `preview`.

**Rollout (T50 or a staging push):** push `20261014090000_crash_reports.sql` and deploy
`crash-reports` (no new secret). Until the function is deployed, phones keep their reports and send them
later.

## Setup per environment (operator)

1. In Discord, create a channel webhook (channel settings → Integrations → Webhooks) and copy its
   URL. One channel can serve both environments; messages name the environment.
2. Function secrets: `OPS_MONITOR_SECRET` (a new random value of at least 32 characters per
   environment), `OPS_ALERT_WEBHOOK_URL` (the webhook URL), and optionally `OPS_HEARTBEAT_URL`
   (a separate check per environment). Never paste them into chat, commits or docs.
3. `supabase db push` for `20261011120000_ops_monitoring.sql`, then deploy `ops-monitor` and
   redeploy the eleven functions (they now report signals). All use `verify_jwt = false` and the
   import map in `config.toml`.
4. With pg_net enabled (already on staging), store the URL and the same secret in Vault, by name
   only: `select vault.create_secret('<function URL>', 'ops_monitor_url');` and
   `select vault.create_secret('<OPS_MONITOR_SECRET>', 'ops_monitor_secret');`. Then
   `select private.ops_monitor_schedule();` (`*/5 * * * *`).
5. `npm run release:check -- --variant <preview|production> --secrets <list> --compare <other list>`:
   the two new required names, and `OPS_MONITOR_SECRET`/`OPS_HEARTBEAT_URL` must differ between
   environments.
6. The first run posts whatever is wrong now (on staging today: `redis.reachable` is expected to be
   ok, `cron.jobs` needs the `ops-monitor` job itself). Rotate the secret by setting a new value in
   both the function secrets and Vault.

**Staging (2026-10-11):** not set up. T51a made no hosted changes.

## Tests

- `npm run test:ops`: the rollback-only PGlite suite `supabase/tests/ops-monitoring.sql` (grants,
  signal bounds, every check failing and recovering on cue with a stand-in `cron` schema, real
  rental/group/walk-in/venue-cancellation flows leaving inventory consistent, alert state: posted
  until confirmed, changes, reminders, recoveries, stale confirmations, Redis input, retention) and
  the handler/reporter/Discord/Redis/deps tests. `npm run test:domain` includes the contract test that
  ties check names and signal sources to the migration and the function directories.
- `npm run test:ops:local`: the same SQL on Docker (it needs a database without pg_cron); the
  served `ops-monitor` (GET 405, user token and wrong secret 401); served `venue-search` and
  `venue-reports` with Redis absent recording signals; then real pg_cron → pg_net → served
  `ops-monitor` → a fake Discord and heartbeat on loopback (reached through
  `host.docker.internal`). Ten simulated failures post, eleven recoveries post once each, two later
  runs stay quiet, and a refusing Discord leaves alerts unconfirmed (pg_net logs 502, no heartbeat)
  until the next run delivers them. It installs and removes pg_cron/pg_net, Vault secrets and jobs,
  and restores alert state and signals exactly. Run it alone: it replaces any running
  `functions serve` container. It never calls the real Discord.
- `npm run test:ops` also runs `supabase/tests/ops-console.sql` (T51c): grants, the admin recheck,
  live checks equal to `ops_health`, `checked_at` per run, jobs with and without a stand-in cron
  schema, 24-hour windows, signal grouping and caps, no writes; 18 mutations must each fail it.
- `npm run test:health:local` (T51c, after `npm run admin:build`): the Docker console and T51a SQL,
  then the production console with Mailpit sign-in: guests to sign-in, moderators and players refused,
  a fresh page, a recorded Edge signal and an unfinished deletion shown live, a monitor run and its
  posts, a 20-minute-silent monitor called stopped, a revoked admin refused. It restores alert state
  and signals exactly and removes its accounts.
- `npm run test:crashes` (T51d): the PGlite suite `supabase/tests/crash-reports.sql` (grants, the strict
  contract, one row per report, the daily cap, `app.crashes`, the admin read's groups and windows,
  30-day retention; 25 mutations must each fail it), the function's handler tests and the mobile queue
  and handler tests (including the shipped queue against the real handler). `npm run test:crashes:local`:
  the same SQL on Docker, the served function (GET 405, 413, 400, 415), the shipped mobile queue sending
  as the app does, a monitor run raising `app.crashes` (a development report not counted) and the admin
  read (moderator, player and anon refused). `npm run test:health:local` also checks the page's App
  crashes section.
- Other local harnesses' served functions leave a few signal rows behind (harmless; pruned after two
  days by monitor runs).
