# Monitoring and operator alerts (T51a)

The backend checks itself every five minutes and posts to the operators' Discord channel when
something breaks. It posts again every six hours while the problem lasts, and once when it clears.
Mobile crash reporting, a console health page and paging are not part of this (T51). T51b added the
storage sweep's job and backlog check.

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
- Other local harnesses' served functions leave a few signal rows behind (harmless; pruned after two
  days by monitor runs).
