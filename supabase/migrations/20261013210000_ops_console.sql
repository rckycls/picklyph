-- T51c: the console's System health page. ops_monitor_run now stamps when it last evaluated each check, and the
-- service-only ops_admin_read gives administrators the live checks (the same private.ops_health the monitor
-- runs), the monitor's stored alert state, the scheduled jobs' last day and per-function Edge signal counts.
-- Counts, job names, schedules and pg_cron messages only. It writes nothing. See docs/monitoring.md.

-- When a monitor run last evaluated the check. Null for rows written before this migration.
alter table private.ops_alert_state add column checked_at timestamptz;

-- As in 20261011120000, plus checked_at on every run (checks missing from a run keep theirs).
create or replace function public.ops_monitor_run(external_checks jsonb default '[]'::jsonb) returns jsonb
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
    insert into private.ops_alert_state as x (check_name, status, observed, since, checked_at)
      values (item->>'check', item->>'status', (item->>'count')::integer, at_time, at_time)
    on conflict (check_name) do update set observed = excluded.observed, status = excluded.status, checked_at = excluded.checked_at,
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

-- The console's view. Administrators only: the role is rechecked here and the actor is the console's verified
-- session. Jobs are null without pg_cron. Job runs and signals cover the last 24 hours; one pass over the run
-- history, which pg_cron never trims by itself.
create function public.ops_admin_read(actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz; jobs jsonb;
begin
  perform private.require_directory_admin(actor_user_id);
  at_time := clock_timestamp();
  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    with expected as (
      select e.name, e.n from unnest(array['booking-expiry-sweep','push-dispatch','privacy-retention-sweep','ops-monitor','storage-sweep'])
        with ordinality e(name, n)
    ), named as (
      select e.name, e.n, c.jobid, c.active, c.schedule from expected e
        left join lateral (select j.jobid, j.active, j.schedule from cron.job j where j.jobname = e.name
          order by j.active desc, j.jobid desc limit 1) c on true
    ), recent as materialized (
      select d.jobid, d.runid, d.status, d.start_time, d.return_message from cron.job_run_details d
        where d.start_time > at_time - interval '24 hours' and d.jobid in (select m.jobid from named m where m.jobid is not null)
    )
    select jsonb_agg(jsonb_build_object('job', m.name, 'present', m.jobid is not null, 'active', coalesce(m.active, false),
        'schedule', m.schedule, 'last_run_at', last_run.start_time, 'last_status', last_run.status,
        'last_success_at', (select max(r.start_time) from recent r where r.jobid = m.jobid and r.status = 'succeeded'),
        'failures', (select count(*) from recent r where r.jobid = m.jobid and r.status = 'failed'),
        'last_failure_at', last_failure.start_time, 'last_failure', left(last_failure.return_message, 300))
      order by m.n) into jobs
    from named m
      left join lateral (select r.start_time, r.status from recent r where r.jobid = m.jobid
        order by r.start_time desc, r.runid desc limit 1) last_run on true
      left join lateral (select r.start_time, r.return_message from recent r where r.jobid = m.jobid and r.status = 'failed'
        order by r.start_time desc, r.runid desc limit 1) last_failure on true;
  end if;
  return jsonb_build_object(
    'at', at_time,
    'checks', private.ops_health(at_time),
    'state', (select coalesce(jsonb_agg(jsonb_build_object('check', x.check_name, 'status', x.status, 'count', x.observed,
        'since', x.since, 'checked_at', x.checked_at, 'notified_status', x.notified_status, 'notified_at', x.notified_at)
        order by x.check_name), '[]'::jsonb) from private.ops_alert_state x),
    'monitor_ran_at', (select max(x.checked_at) from private.ops_alert_state x),
    'jobs', jobs,
    -- Same windows as the edge.* checks (minute > at_time - interval).
    'signals', (select coalesce(jsonb_agg(jsonb_build_object('source', g.source, 'kind', g.kind, 'last_15m', least(g.m15, 1000000),
        'last_hour', least(g.h1, 1000000), 'last_day', least(g.d1, 1000000), 'last_at', g.last_at) order by g.source, g.kind), '[]'::jsonb)
      from (select s.source, s.kind,
          coalesce(sum(s.occurrences) filter (where s.minute > at_time - interval '15 minutes'), 0) m15,
          coalesce(sum(s.occurrences) filter (where s.minute > at_time - interval '1 hour'), 0) h1,
          sum(s.occurrences) d1, max(s.minute) last_at
        from private.ops_signals s where s.minute > at_time - interval '24 hours' group by s.source, s.kind) g));
end; $$;

revoke all on function public.ops_admin_read(uuid) from public, anon, authenticated;
grant execute on function public.ops_admin_read(uuid) to service_role;
notify pgrst, 'reload schema';
