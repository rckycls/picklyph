-- T51a: backend health checks and operator alerts. Edge functions count their 5xx and rate-limiter
-- outage answers per minute; private.ops_health evaluates fixed checks that carry counts only (never
-- IDs, names, emails or secret values); ops_monitor_run keeps alert state so the ops-monitor function
-- posts a change, a reminder every six hours while it lasts and one recovery. See docs/monitoring.md.

-- One row per minute, function and kind. Functions write at most once per minute and kind per isolate.
create table private.ops_signals (
  minute timestamptz not null check (date_trunc('minute', minute) = minute),
  source text not null check (source in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
    'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch')),
  kind text not null check (kind in ('server_error','unavailable','limiter_degraded')),
  occurrences integer not null check (occurrences between 1 and 1000000),
  primary key (minute, source, kind)
);

-- One row per check: what it is now, since when, and what the operators were last told.
create table private.ops_alert_state (
  check_name text primary key check (check_name ~ '^[a-z]+\.[a-z_]+$'),
  status text not null check (status in ('ok','warn','fail')),
  observed integer not null check (observed >= 0),
  since timestamptz not null,
  notified_status text check (notified_status in ('ok','warn','fail')),
  notified_at timestamptz,
  check ((notified_status is null) = (notified_at is null))
);
alter table private.ops_signals enable row level security;
alter table private.ops_alert_state enable row level security;
revoke all on private.ops_signals, private.ops_alert_state from public, anon, authenticated, service_role;

create function public.ops_signal_record(signal_source text, signal_kind text, occurrences integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if signal_source is null or signal_source not in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
      'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch')
    or signal_kind is null or signal_kind not in ('server_error','unavailable','limiter_degraded')
    or occurrences is null or occurrences not between 1 and 10000 then
    raise exception 'Invalid signal' using errcode='22023', hint='invalid_input';
  end if;
  insert into private.ops_signals(minute, source, kind, occurrences)
    values (date_trunc('minute', clock_timestamp()), signal_source, signal_kind, occurrences)
  on conflict (minute, source, kind) do update set occurrences = least(private.ops_signals.occurrences + excluded.occurrences, 1000000);
end; $$;

create function private.ops_check(check_name text, observed bigint, warn_at bigint, fail_at bigint) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('check', check_name, 'count', least(observed, 1000000)::integer,
    'status', case when observed >= fail_at then 'fail' when observed >= warn_at then 'warn' else 'ok' end);
$$;

-- Thresholds live here, so changing one is one migration. Each check is bounded to recent rows.
create function private.ops_health(at_time timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  checks jsonb := '[]'::jsonb;
  expected text[] := array['booking-expiry-sweep','push-dispatch','privacy-retention-sweep','ops-monitor'];
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

-- One monitor run. external_checks are the Redis checks only the function can make. Checks missing from
-- a run keep their state. An alert is due when a check changed from what was last posted, or has stayed
-- in warn/fail for six hours since the last post. Nothing is marked posted here: see ops_alerts_confirm.
create function public.ops_monitor_run(external_checks jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz; checks jsonb; item jsonb; alerts jsonb := '[]'::jsonb; saved private.ops_alert_state;
begin
  if external_checks is null or jsonb_typeof(external_checks) <> 'array' or jsonb_array_length(external_checks) > 2
    or exists (select 1 from jsonb_array_elements(external_checks) e
      where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 3
        or coalesce(e->>'check', '') not in ('redis.reachable','redis.isolation')
        or coalesce(e->>'status', '') not in ('ok','warn','fail')
        or coalesce(jsonb_typeof(e->'count'), '') <> 'number' or coalesce(e->>'count', '') !~ '^[0-9]{1,6}$')
    or (select count(distinct e->>'check') from jsonb_array_elements(external_checks) e) <> jsonb_array_length(external_checks) then
    raise exception 'Invalid checks' using errcode='22023', hint='invalid_input';
  end if;
  -- Overlapping runs take turns, so state changes are never lost between them.
  perform pg_advisory_xact_lock(5106001);
  at_time := clock_timestamp();
  delete from private.ops_signals s where s.minute < at_time - interval '2 days';
  checks := private.ops_health(at_time) || external_checks;
  for item in select value from jsonb_array_elements(checks) loop
    insert into private.ops_alert_state as x (check_name, status, observed, since)
      values (item->>'check', item->>'status', (item->>'count')::integer, at_time)
    on conflict (check_name) do update set observed = excluded.observed, status = excluded.status,
      since = case when x.status = excluded.status then x.since else excluded.since end
    returning * into saved;
    if saved.status <> coalesce(saved.notified_status, 'ok')
      or (saved.status <> 'ok' and saved.notified_at <= at_time - interval '6 hours') then
      alerts := alerts || jsonb_build_object('check', saved.check_name, 'status', saved.status,
        'previous', coalesce(saved.notified_status, 'ok'), 'count', saved.observed, 'since', saved.since);
    end if;
  end loop;
  return jsonb_build_object('at', at_time, 'checks', checks, 'alerts', alerts);
end; $$;

-- After the operators' channel accepted the post: record what was told. A check that changed again
-- since the run is left alone, so the next run posts its new state.
create function public.ops_alerts_confirm(alerts jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare confirmed integer;
begin
  if alerts is null or jsonb_typeof(alerts) <> 'array' or jsonb_array_length(alerts) > 50
    or exists (select 1 from jsonb_array_elements(alerts) e where jsonb_typeof(e) <> 'object'
      or coalesce(e->>'check', '') !~ '^[a-z]+\.[a-z_]+$' or coalesce(e->>'status', '') not in ('ok','warn','fail')) then
    raise exception 'Invalid alerts' using errcode='22023', hint='invalid_input';
  end if;
  perform pg_advisory_xact_lock(5106001);
  update private.ops_alert_state x set notified_status = x.status, notified_at = clock_timestamp()
    from (select distinct e->>'check' as check_name, e->>'status' as status from jsonb_array_elements(alerts) e) a
    where x.check_name = a.check_name and x.status = a.status;
  get diagnostics confirmed = row_count;
  return jsonb_build_object('confirmed', confirmed);
end; $$;

-- pg_cron caller, like push_dispatch_kick: posts to the ops-monitor function with the Vault secrets.
create function private.ops_monitor_kick() returns bigint
language plpgsql security definer set search_path='' as $$
declare target text; secret text;
begin
  select s.decrypted_secret into target from vault.decrypted_secrets s where s.name = 'ops_monitor_url';
  select s.decrypted_secret into secret from vault.decrypted_secrets s where s.name = 'ops_monitor_secret';
  if target is null or secret is null then
    raise exception 'Ops monitor is not configured' using errcode = '55000', hint = 'not_configured';
  end if;
  return net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 30000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret));
end; $$;

-- Idempotent: pg_cron updates the named job. Run only after the Vault secrets exist.
create function private.ops_monitor_schedule() returns bigint
language plpgsql set search_path='' as $$
begin
  return cron.schedule('ops-monitor', '*/5 * * * *', 'select private.ops_monitor_kick()');
end; $$;

revoke all on function public.ops_signal_record(text,text,integer), private.ops_check(text,bigint,bigint,bigint),
  private.ops_health(timestamptz), public.ops_monitor_run(jsonb), public.ops_alerts_confirm(jsonb),
  private.ops_monitor_kick(), private.ops_monitor_schedule()
  from public, anon, authenticated, service_role;
grant execute on function public.ops_signal_record(text,text,integer), public.ops_monitor_run(jsonb), public.ops_alerts_confirm(jsonb)
  to service_role;
