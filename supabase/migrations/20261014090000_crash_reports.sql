-- T51d: anonymous crash reports from the mobile app. The crash-reports function stores one row per report, keyed by the
-- device's random report ID so a resent report is stored once. Nothing links a report to an account, device or IP.
-- private.ops_health gains app.crashes (preview/production crashes in the last hour), the console reads crash groups
-- through the admin-only crash_admin_read, and the daily privacy sweep removes reports after 30 days.
-- See docs/monitoring.md#mobile-crash-reports-t51d.

create table private.app_crashes (
  id uuid primary key,
  received_at timestamptz not null default clock_timestamp(),
  occurred_at timestamptz not null,
  kind text not null check (kind in ('fatal','error','render')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  name text not null check (char_length(name) <= 100 and name ~ '\S'),
  message text not null check (char_length(message) <= 500),
  stack text check (char_length(stack) <= 6000),
  component_stack text check (char_length(component_stack) <= 3000),
  route text check (char_length(route) <= 200 and route ~ '^/[^\s?#]*$'),
  app_version text not null check (app_version ~ '^[0-9A-Za-z.+-]{1,32}$'),
  variant text not null check (variant in ('development','preview','production')),
  os text not null check (os in ('ios','android')),
  os_version text not null check (os_version ~ '^[0-9A-Za-z._ -]{1,32}$'),
  check (component_stack is null or kind = 'render')
);
create index app_crashes_received_at on private.app_crashes (received_at);
create index app_crashes_fingerprint on private.app_crashes (fingerprint, received_at desc);
alter table private.app_crashes enable row level security;
revoke all on private.app_crashes from public, anon, authenticated, service_role;

-- The crash-reports function only, after its own strict parse and scrub (domain crash.ts). Refuses anything off the
-- contract, stores a report once, and stops storing after 2,000 reports in a day, so a client sending junk cannot fill
-- the database (the function keeps accepting under a Redis outage).
create function public.crash_report_record(report jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  keys text[] := array['id','kind','name','message','stack','component_stack','route','app_version','variant','os','os_version','occurred_at','fingerprint'];
  report_id uuid;
begin
  if report is null or jsonb_typeof(report) <> 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(report) k) is distinct from (select array_agg(k order by k) from unnest(keys) k)
    or exists (select 1 from unnest(keys) k where jsonb_typeof(report->k) <> 'string'
      and not (k in ('stack','component_stack','route') and jsonb_typeof(report->k) = 'null'))
    or report->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or report->>'occurred_at' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Invalid crash report' using errcode='22023', hint='invalid_input';
  end if;
  report_id := (report->>'id')::uuid;
  -- Reports take turns, so the daily cap holds under concurrent sends.
  perform pg_advisory_xact_lock(5106002);
  if exists (select 1 from private.app_crashes c where c.id = report_id) then
    return jsonb_build_object('outcome', 'existing');
  end if;
  if (select count(*) from private.app_crashes c where c.received_at > clock_timestamp() - interval '24 hours') >= 2000 then
    return jsonb_build_object('outcome', 'capped');
  end if;
  begin
    insert into private.app_crashes (id, occurred_at, kind, fingerprint, name, message, stack, component_stack, route,
        app_version, variant, os, os_version)
      values (report_id, (report->>'occurred_at')::timestamptz, report->>'kind', report->>'fingerprint', report->>'name',
        report->>'message', report->>'stack', report->>'component_stack', report->>'route', report->>'app_version',
        report->>'variant', report->>'os', report->>'os_version');
  exception when check_violation or datetime_field_overflow or invalid_datetime_format then
    raise exception 'Invalid crash report' using errcode='22023', hint='invalid_input';
  end;
  return jsonb_build_object('outcome', 'stored');
end; $$;

-- The monitor: crash-reports reports Edge signals like the other functions.
alter table private.ops_signals drop constraint ops_signals_source_check,
  add constraint ops_signals_source_check check (source in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
    'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch','storage-sweep','crash-reports'));

create or replace function public.ops_signal_record(signal_source text, signal_kind text, occurrences integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if signal_source is null or signal_source not in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
      'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch','storage-sweep','crash-reports')
    or signal_kind is null or signal_kind not in ('server_error','unavailable','limiter_degraded')
    or occurrences is null or occurrences not between 1 and 10000 then
    raise exception 'Invalid signal' using errcode='22023', hint='invalid_input';
  end if;
  insert into private.ops_signals(minute, source, kind, occurrences)
    values (date_trunc('minute', clock_timestamp()), signal_source, signal_kind, occurrences)
  on conflict (minute, source, kind) do update set occurrences = least(private.ops_signals.occurrences + excluded.occurrences, 1000000);
end; $$;

-- As in 20261012090000, plus app.crashes.
create or replace function private.ops_health(at_time timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  checks jsonb := '[]'::jsonb;
  expected text[] := array['booking-expiry-sweep','push-dispatch','privacy-retention-sweep','ops-monitor','storage-sweep'];
  n bigint; credentials bigint;
begin
  -- Scheduled jobs: present and active; recent failed runs; every-minute jobs with no recent success.
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    checks := checks || private.ops_check('cron.jobs', cardinality(expected), 1, 1);
  else
    select count(*) into n from unnest(expected) j(name)
      where not exists (select 1 from cron.job c where c.jobname = j.name and c.active);
    checks := checks || private.ops_check('cron.jobs', n, 1, 1);
    select count(*) into n from cron.job_run_details d join cron.job c on c.jobid = d.jobid
      where c.jobname = any(expected) and d.status = 'failed' and d.start_time > at_time - interval '15 minutes';
    checks := checks || private.ops_check('cron.failures', n, 1, 3);
    select count(*) into n from cron.job c
      where c.jobname in ('booking-expiry-sweep','push-dispatch') and c.active
        and not exists (select 1 from cron.job_run_details d where d.jobid = c.jobid and d.status = 'succeeded'
          and d.start_time > at_time - interval '10 minutes');
    checks := checks || private.ops_check('cron.stalled', n, 1, 1);
  end if;

  -- Holds the every-minute sweep should have recorded as expired by now. Reads already treat them as
  -- expired, so this means the sweep is not running, not that inventory is wrong.
  select (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
      where b.status = 'pending' and a.expires_at <= at_time - interval '10 minutes')
    + (select count(*) from private.session_bookings b where b.status = 'pending' and b.expires_at <= at_time - interval '10 minutes')
    into n;
  checks := checks || private.ops_check('holds.overdue', n, 1, 1);

  -- Inventory that disagrees with bookings: a confirmed rental without its firm court, a finished one
  -- still holding it, rental or session inventory with no owner, a session counter that differs from its
  -- live groups, or session courts out of step with the session. Recent and upcoming rows only.
  select (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
      where a.ends_at > at_time - interval '2 days' and (
        (b.status = 'confirmed' and (a.state <> 'active' or a.expires_at is not null))
        or (b.status = 'pending' and a.state = 'released')
        or (b.status in ('declined','cancelled','expired') and a.state = 'active' and (a.expires_at is null or a.expires_at > at_time))))
    + (select count(*) from private.court_allocations a where a.ends_at > at_time - interval '2 days' and a.state = 'active'
        and ((a.kind = 'rental' and not exists (select 1 from private.rental_bookings b where b.id = a.id))
          or (a.kind = 'session' and not exists (select 1 from private.session_courts sc where sc.allocation_id = a.id))))
    + (select count(*) from private.open_play_sessions s where s.ends_at > at_time - interval '2 days' and (
        s.reserved_spots <> coalesce((select sum(b.spots) from private.session_bookings b
          where b.session_id = s.id and b.status in ('pending','confirmed')), 0)
        or exists (select 1 from private.session_courts sc join private.court_allocations a on a.id = sc.allocation_id
          where sc.session_id = s.id and (s.status = 'scheduled') <> (a.state = 'active' and a.expires_at is null))))
    into n;
  checks := checks || private.ops_check('inventory.mismatch', n, 1, 1);

  -- Push: rows the worker should have taken by now, and rows or receipts that failed in the last hours.
  select count(*) into n from private.notification_outbox o
    where (o.status = 'pending' and o.next_attempt_at <= at_time - interval '10 minutes')
      or (o.status = 'sending' and o.locked_until <= at_time - interval '10 minutes');
  checks := checks || private.ops_check('push.backlog', n, 1, 1);
  -- Credential/sender errors fail every later push too (APNs key or Expo access token), so one is enough.
  select count(*) filter (where o.last_error is null or o.last_error not in ('invalid_credentials','mismatch_sender_id','expo_rejected')),
      count(*) filter (where o.last_error in ('invalid_credentials','mismatch_sender_id','expo_rejected'))
    into n, credentials from private.notification_outbox o
    where o.status = 'failed' and o.finished_at > at_time - interval '1 hour';
  n := n + (select count(*) from private.push_deliveries p where p.receipt = 'error' and p.receipt_error is distinct from 'device_not_registered'
    and p.sent_at > at_time - interval '2 hours');
  checks := checks || private.ops_check('push.failures', n, 1, 10) || private.ops_check('push.credentials', credentials, 1, 1);

  -- Edge function answers recorded through ops_signal_record during the last 15 minutes.
  select coalesce(sum(s.occurrences) filter (where s.kind = 'server_error'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.errors', n, 1, 5);
  select coalesce(sum(s.occurrences) filter (where s.kind = 'unavailable'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.unavailable', n, 5, 25);
  select coalesce(sum(s.occurrences) filter (where s.kind = 'limiter_degraded'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.limiter', n, 1, 1);

  -- Account deletions that started over an hour ago and still have an Auth user (storage or Auth step failed).
  select count(*) into n from private.account_deletions d
    where d.requested_at <= at_time - interval '1 hour' and exists (select 1 from auth.users u where u.id = d.user_id);
  checks := checks || private.ops_check('privacy.deletions', n, 1, 1);

  -- Files the daily storage sweep should have removed over a day ago: it is not running, or Storage
  -- keeps refusing them. The whole of the three buckets is checked, which is fine at pilot scale.
  select count(*) into n from private.storage_sweep_candidates(at_time - interval '1 day');
  checks := checks || private.ops_check('storage.backlog', n, 1, 25);

  -- T51d: crashes and failed screens reported by preview and production builds in the last hour. Development
  -- builds report too (the console lists them) but never alert.
  select count(*) into n from private.app_crashes c
    where c.received_at > at_time - interval '1 hour' and c.kind in ('fatal','render') and c.variant <> 'development';
  checks := checks || private.ops_check('app.crashes', n, 1, 10);

  -- The pilot is pay-on-arrival only (user decision 2026-10-10): no merchant, stored online policy or live
  -- booking snapshot may offer online payment. Replace this check when online payments resume.
  select (select count(*) from private.venue_merchants m where m.active)
    + (select count(*) from private.venue_policies p where p.payment <> 'arrival')
    + (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
        join private.rental_snapshots s on s.allocation_id = b.id
        where b.status in ('pending','confirmed') and a.ends_at > at_time and s.snapshot->'policy'->>'payment' is distinct from 'arrival')
    + (select count(*) from private.open_play_sessions s
        where s.status = 'scheduled' and s.ends_at > at_time and s.snapshot->'policy'->>'payment' is distinct from 'arrival')
    into n;
  checks := checks || private.ops_check('rollout.arrival_only', n, 1, 1);
  return checks;
end; $$;

-- As in 20261013150000, plus crash reports older than 30 days.
create or replace function private.privacy_retention_sweep(batch_limit integer default 500) returns jsonb
language plpgsql set search_path = '' as $$
declare cleared integer; erased integer := 0; claimed integer := 0; crashes integer; item record;
begin
  if batch_limit is null or batch_limit not between 1 and 10000 then
    raise exception 'Invalid batch limit' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.venue_reports r set details = null where r.id in (
    select x.id from private.venue_reports x
      where x.status <> 'open' and x.details is not null and x.reviewed_at < clock_timestamp() - interval '180 days'
      order by x.reviewed_at, x.id limit batch_limit for update skip locked);
  get diagnostics cleared = row_count;
  for item in select r.id, r.venue_id from private.venue_registrations r
    where r.status = 'open' and coalesce(r.email_sent_at, r.created_at) < clock_timestamp() - interval '180 days'
    order by coalesce(r.email_sent_at, r.created_at), r.id limit batch_limit loop
    perform 1 from public.venues v where v.id = item.venue_id for update;
    perform 1 from private.venue_registrations r where r.id = item.id and r.status = 'open'
      and coalesce(r.email_sent_at, r.created_at) < clock_timestamp() - interval '180 days' for update;
    continue when not found;
    update private.venue_registrations r set status = 'erased', owner_name = null, email = null, phone = null,
      note = null, code_hash = null, erased_at = clock_timestamp() where r.id = item.id;
    update public.venues v set publication_status = 'suspended' where v.id = item.venue_id and v.publication_status = 'draft';
    if found then
      insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (item.id, item.venue_id, 'prelaunch.retire');
    end if;
    erased := erased + 1;
  end loop;
  for item in select r.id, r.venue_id from private.venue_registrations r
    where r.status = 'claimed' and not exists (select 1 from private.venue_submissions s where s.id = r.submission_id
      and (s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days'))
    order by r.claimed_at, r.id limit batch_limit loop
    perform 1 from public.venues v where v.id = item.venue_id for update;
    perform 1 from private.venue_registrations r where r.id = item.id and r.status = 'claimed'
      and not exists (select 1 from private.venue_submissions s where s.id = r.submission_id
        and (s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days')) for update;
    continue when not found;
    update private.venue_registrations r set status = 'erased', owner_name = null, email = null, phone = null,
      note = null, erased_at = clock_timestamp() where r.id = item.id;
    claimed := claimed + 1;
  end loop;
  -- T51d: crash reports are kept 30 days.
  delete from private.app_crashes c where c.id in (
    select x.id from private.app_crashes x where x.received_at < clock_timestamp() - interval '30 days'
      order by x.received_at, x.id limit batch_limit for update skip locked);
  get diagnostics crashes = row_count;
  return jsonb_build_object('report_details', cleared, 'prelaunch_registrations', erased + claimed, 'crash_reports', crashes,
    'more', cleared = batch_limit or erased = batch_limit or claimed = batch_limit or crashes = batch_limit);
end;
$$;

-- The console's App crashes section. Administrators only: the role is rechecked here and the actor is the console's
-- verified session. The last 7 days, grouped by fingerprint: at most 50 groups, most recently seen first, each with its
-- counts per build variant and the latest report's details. Times are the server's receipt times. It writes nothing.
create function public.crash_admin_read(actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz;
begin
  perform private.require_directory_admin(actor_user_id);
  at_time := clock_timestamp();
  return jsonb_build_object(
    'at', at_time,
    'days', 7,
    'total', (select count(*) from private.app_crashes c where c.received_at > at_time - interval '7 days'),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('fingerprint', g.fingerprint, 'kind', l.kind, 'name', l.name,
        'message', l.message, 'reports', g.reports, 'development', g.development, 'preview', g.preview, 'production', g.production,
        'first_seen', g.first_seen, 'last_seen', g.last_seen, 'app_version', l.app_version, 'os', l.os, 'os_version', l.os_version,
        'route', l.route, 'stack', l.stack, 'component_stack', l.component_stack) order by g.last_seen desc, g.fingerprint), '[]'::jsonb)
      from (select c.fingerprint, count(*) reports, count(*) filter (where c.variant = 'development') development,
          count(*) filter (where c.variant = 'preview') preview, count(*) filter (where c.variant = 'production') production,
          min(c.received_at) first_seen, max(c.received_at) last_seen
        from private.app_crashes c where c.received_at > at_time - interval '7 days'
        group by c.fingerprint order by max(c.received_at) desc, c.fingerprint limit 50) g
      cross join lateral (select c.kind, c.name, c.message, c.app_version, c.os, c.os_version, c.route, c.stack, c.component_stack
        from private.app_crashes c where c.fingerprint = g.fingerprint and c.received_at > at_time - interval '7 days'
        order by c.received_at desc, c.id limit 1) l));
end; $$;

revoke all on function public.crash_report_record(jsonb), public.crash_admin_read(uuid) from public, anon, authenticated;
grant execute on function public.crash_report_record(jsonb), public.crash_admin_read(uuid) to service_role;
notify pgrst, 'reload schema';
