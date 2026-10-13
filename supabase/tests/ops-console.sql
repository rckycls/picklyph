-- Rollback-only T51c fixtures: the console's ops_admin_read (grants, the admin role rechecked, live checks equal to
-- private.ops_health, the monitor's stored state and run time, scheduled jobs with and without a stand-in cron
-- schema, 24-hour windows, per-function signals) writes nothing, and ops_monitor_run stamps checked_at. Commands
-- run as service_role (the console's client); assertions run as the owner. PGlite and Docker without pg_cron.
begin;
do $$ begin
  if to_regclass('cron.job') is not null then raise exception 'Run ops-console.sql without pg_cron; it adds a stand-in cron schema'; end if;
end $$;
-- Other local harnesses' served functions leave signals behind; this transaction starts quiet (and rolls back).
delete from private.ops_signals;
delete from private.ops_alert_state;

create schema oc_test;
grant usage on schema oc_test to anon, authenticated, service_role;
create function oc_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Ops console assertion failed: %', message; end if; end; $$;
create function oc_test.expect_error(statement text, code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = code then return; end if;
    raise exception 'Ops console assertion failed: expected %, got %: %', code, sqlstate, sqlerrm;
  end;
  raise exception 'Ops console assertion failed: expected failure: %', statement;
end; $$;
create function oc_test.u(n text) returns uuid language sql immutable as $$ select ('c5100000-0000-4000-8000-00000000000'||n)::uuid; $$;
-- Everything that must not change during a read.
create function oc_test.stored() returns jsonb language sql stable as $$
  select jsonb_build_array((select jsonb_agg(to_jsonb(x) order by x.check_name) from private.ops_alert_state x),
    (select jsonb_agg(to_jsonb(s) order by s.minute, s.source, s.kind) from private.ops_signals s)); $$;
create function oc_test.state(view jsonb, name text) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(view->'state') e where e->>'check' = name; $$;
create temporary table oc_view (name text primary key, view jsonb) on commit drop;
create temporary table oc_runs (name text primary key, at timestamptz) on commit drop;
grant all on oc_view, oc_runs to service_role;
create function oc_test.view(text) returns jsonb language sql stable as $$ select v.view from oc_view v where v.name = $1; $$;
create function oc_test.ran(text) returns timestamptz language sql stable as $$ select r.at from oc_runs r where r.name = $1; $$;

-- Accounts: admin (1), moderator (2), player (3).
insert into auth.users(id) values (oc_test.u('1')), (oc_test.u('2')), (oc_test.u('3'));
insert into private.account_roles(user_id, role) values (oc_test.u('1'), 'admin'), (oc_test.u('2'), 'moderator');

-- Grants: the console's service client only.
select oc_test.assert_that(not has_function_privilege('anon', 'public.ops_admin_read(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.ops_admin_read(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.ops_admin_read(uuid)', 'execute'), 'only the service role reads');
set local role authenticated;
select oc_test.expect_error(format('select public.ops_admin_read(%L)', oc_test.u('1')), '42501');
reset role;

set local role service_role;
-- The database rechecks the administrator role: moderators, players, unknown and missing actors are refused.
select oc_test.expect_error(format('select public.ops_admin_read(%L)', oc_test.u('2')), '42501');
select oc_test.expect_error(format('select public.ops_admin_read(%L)', oc_test.u('3')), '42501');
select oc_test.expect_error(format('select public.ops_admin_read(%L)', oc_test.u('9')), '42501');
select oc_test.expect_error('select public.ops_admin_read(null)', '42501');
-- A database the monitor never ran on, without pg_cron: live checks only.
insert into oc_view values ('fresh', public.ops_admin_read(oc_test.u('1')));
reset role;
select oc_test.assert_that(oc_test.view('fresh')->'checks' = private.ops_health(clock_timestamp()), 'live checks are the monitor''s own ops_health');
select oc_test.assert_that(oc_test.view('fresh')->'checks' @> '[{"check":"cron.jobs","status":"fail","count":5}]',
  'without pg_cron every expected job is missing');
select oc_test.assert_that(jsonb_typeof(oc_test.view('fresh')->'jobs') = 'null' and oc_test.view('fresh')->'state' = '[]'
  and oc_test.view('fresh')->'signals' = '[]' and jsonb_typeof(oc_test.view('fresh')->'monitor_ran_at') = 'null'
  and (oc_test.view('fresh')->>'at')::timestamptz <= clock_timestamp(), 'no jobs without pg_cron, no state, no signals and no monitor run yet');
select oc_test.assert_that((select array_agg(k order by k) from jsonb_object_keys(oc_test.view('fresh')) k)
  = array['at','checks','jobs','monitor_ran_at','signals','state'], 'nothing else is returned');

-- The monitor stamps every check it evaluates; checks missing from a run keep their time.
set local role service_role;
insert into oc_runs select 'first', (public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.isolation","status":"fail","count":1}]')->>'at')::timestamptz;
reset role;
select oc_test.assert_that((select count(*) from private.ops_alert_state x where x.checked_at = oc_test.ran('first')) = 14,
  'the first run stamps its twelve database checks and both Redis checks');
set local role service_role;
select public.ops_alerts_confirm('[{"check":"cron.jobs","status":"fail"}]');
insert into oc_runs select 'second', (public.ops_monitor_run('[]')->>'at')::timestamptz;
insert into oc_view values ('ran', public.ops_admin_read(oc_test.u('1')));
reset role;
select oc_test.assert_that((select count(*) from private.ops_alert_state x where x.checked_at = oc_test.ran('second')) = 12
  and (select count(*) from private.ops_alert_state x where x.check_name like 'redis.%' and x.checked_at = oc_test.ran('first')) = 2,
  'a run without Redis checks leaves their time alone');
select oc_test.assert_that((oc_test.view('ran')->>'monitor_ran_at')::timestamptz = oc_test.ran('second'), 'the monitor last ran at its latest stamp');
select oc_test.assert_that(jsonb_array_length(oc_test.view('ran')->'state') = 14, 'every tracked check is listed');
select oc_test.assert_that(oc_test.state(oc_test.view('ran'), 'cron.jobs') = jsonb_build_object('check', 'cron.jobs',
    'status', 'fail', 'count', 5, 'since', oc_test.ran('first'), 'checked_at', oc_test.ran('second'),
    'notified_status', 'fail', 'notified_at', (select notified_at from private.ops_alert_state where check_name = 'cron.jobs')),
  'a posted check: status, count, since its first run, last checked and what the channel was told');
select oc_test.assert_that(oc_test.state(oc_test.view('ran'), 'redis.isolation') = jsonb_build_object('check', 'redis.isolation',
    'status', 'fail', 'count', 1, 'since', oc_test.ran('first'), 'checked_at', oc_test.ran('first'), 'notified_status', null, 'notified_at', null),
  'an unposted Redis problem keeps the time of the run that saw it');
select oc_test.assert_that((select array_agg(e->>'check' order by n) from jsonb_array_elements(oc_test.view('ran')->'state') with ordinality s(e, n))
  = (select array_agg(check_name order by check_name) from private.ops_alert_state), 'state in name order');

-- Edge signals per function and kind: 15 minutes, an hour, 24 hours, the last minute; counts capped like checks.
create temporary table oc_now on commit drop as select date_trunc('minute', clock_timestamp()) m, clock_timestamp() t;
insert into private.ops_signals(minute, source, kind, occurrences) select m - w, s, k, n from oc_now, (values
  (interval '5 minutes', 'venue-search', 'server_error', 2), (interval '20 minutes', 'venue-search', 'server_error', 3),
  (interval '90 minutes', 'venue-search', 'server_error', 4), (interval '25 hours', 'venue-search', 'server_error', 100),
  (interval '5 minutes', 'owner-venues', 'server_error', 600000), (interval '6 minutes', 'owner-venues', 'server_error', 600000),
  (interval '20 minutes', 'rental-bookings', 'unavailable', 2), (interval '23 hours', 'account-deletion', 'limiter_degraded', 1),
  (interval '26 hours', 'push-devices', 'unavailable', 7)) v(w, s, k, n);
set local role service_role;
insert into oc_view values ('signals', public.ops_admin_read(oc_test.u('1')));
reset role;
select oc_test.assert_that(oc_test.view('signals')->'signals' = (select jsonb_build_array(
    jsonb_build_object('source', 'account-deletion', 'kind', 'limiter_degraded', 'last_15m', 0, 'last_hour', 0, 'last_day', 1, 'last_at', m - interval '23 hours'),
    jsonb_build_object('source', 'owner-venues', 'kind', 'server_error', 'last_15m', 1000000, 'last_hour', 1000000, 'last_day', 1000000, 'last_at', m - interval '5 minutes'),
    jsonb_build_object('source', 'rental-bookings', 'kind', 'unavailable', 'last_15m', 0, 'last_hour', 2, 'last_day', 2, 'last_at', m - interval '20 minutes'),
    jsonb_build_object('source', 'venue-search', 'kind', 'server_error', 'last_15m', 2, 'last_hour', 5, 'last_day', 9, 'last_at', m - interval '5 minutes'))
  from oc_now), 'signals grouped by function and kind, in order, within 24 hours');
select oc_test.assert_that(oc_test.view('signals')->'checks' = private.ops_health(clock_timestamp()), 'live edge checks follow the signals');

-- A read writes nothing: alert state, what was posted and signals stay as they were.
create temporary table oc_before on commit drop as select oc_test.stored() stored;
set local role service_role;
select public.ops_admin_read(oc_test.u('1'));
reset role;
select oc_test.assert_that(oc_test.stored() = (select stored from oc_before), 'reading changes nothing');

-- With pg_cron (a stand-in schema): the five expected jobs, their last 24 hours and pg_cron's failure message.
create schema cron;
create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, nodename text not null default 'localhost',
  nodeport integer not null default 5432, database text not null default current_database(), username text not null default current_user,
  active boolean not null default true, jobname text);
create table cron.job_run_details (jobid bigint, runid bigserial primary key, job_pid integer, database text, username text, command text,
  status text not null, return_message text, start_time timestamptz, end_time timestamptz);
insert into cron.job(jobid, schedule, command, jobname, active) values
  (1, '* * * * *', 'select private.booking_expiry_sweep()', 'booking-expiry-sweep', true),
  (2, '* * * * *', 'select private.push_dispatch_kick()', 'push-dispatch', false),
  (3, '*/5 * * * *', 'select private.ops_monitor_kick()', 'ops-monitor', true),
  (4, '*/10 * * * *', 'select private.ops_monitor_kick()', 'ops-monitor', false),
  (5, '47 19 * * *', 'select private.storage_sweep_kick()', 'storage-sweep', true),
  (6, '* * * * *', 'select 1', 'someone-elses-job', true);
insert into cron.job_run_details(runid, jobid, status, return_message, start_time) select r, j, s, msg, t - w from oc_now, (values
  (10, 1, 'succeeded', '1 row', interval '2 minutes'), (11, 1, 'failed', 'ERROR: ' || repeat('x', 400), interval '1 minute'),
  (12, 1, 'failed', 'ERROR: older failure', interval '10 minutes'), (13, 1, 'succeeded', '1 row', interval '25 hours'),
  (20, 2, 'succeeded', '1 row', interval '30 minutes'), (21, 2, 'running', null, interval '29 minutes'),
  (40, 4, 'succeeded', '1 row', interval '1 minute'), (30, 3, 'failed', 'ERROR: Ops monitor is not configured', interval '26 hours'),
  (50, 5, 'failed', 'ERROR: Storage sweep is not configured', interval '25 hours'),
  (60, 6, 'failed', 'ERROR: not ours', interval '1 minute')) v(r, j, s, msg, w);
set local role service_role;
insert into oc_view values ('jobs', public.ops_admin_read(oc_test.u('1')));
reset role;
select oc_test.assert_that(oc_test.view('jobs')->'jobs' = (select jsonb_build_array(
    jsonb_build_object('job', 'booking-expiry-sweep', 'present', true, 'active', true, 'schedule', '* * * * *',
      'last_run_at', t - interval '1 minute', 'last_status', 'failed', 'last_success_at', t - interval '2 minutes', 'failures', 2,
      'last_failure_at', t - interval '1 minute', 'last_failure', left('ERROR: ' || repeat('x', 400), 300)),
    jsonb_build_object('job', 'push-dispatch', 'present', true, 'active', false, 'schedule', '* * * * *',
      'last_run_at', t - interval '29 minutes', 'last_status', 'running', 'last_success_at', t - interval '30 minutes', 'failures', 0,
      'last_failure_at', null, 'last_failure', null),
    jsonb_build_object('job', 'privacy-retention-sweep', 'present', false, 'active', false, 'schedule', null,
      'last_run_at', null, 'last_status', null, 'last_success_at', null, 'failures', 0, 'last_failure_at', null, 'last_failure', null),
    jsonb_build_object('job', 'ops-monitor', 'present', true, 'active', true, 'schedule', '*/5 * * * *',
      'last_run_at', null, 'last_status', null, 'last_success_at', null, 'failures', 0, 'last_failure_at', null, 'last_failure', null),
    jsonb_build_object('job', 'storage-sweep', 'present', true, 'active', true, 'schedule', '47 19 * * *',
      'last_run_at', null, 'last_status', null, 'last_success_at', null, 'failures', 0, 'last_failure_at', null, 'last_failure', null))
  from oc_now), format('jobs in order: the active row of a name, the last 24 hours only, failure messages cut to 300 characters; got %s', oc_test.view('jobs')->'jobs'));
select oc_test.assert_that(length(oc_test.view('jobs')->'jobs'->0->>'last_failure') = 300, 'message cut');
select oc_test.assert_that(oc_test.view('jobs')->'checks' = private.ops_health(clock_timestamp()), 'live checks include the cron checks once pg_cron is there');
select oc_test.assert_that(oc_test.view('jobs')->'checks' @> '[{"check":"cron.jobs","status":"fail","count":2},{"check":"cron.failures","status":"warn","count":2}]',
  'two jobs missing or inactive, two recent failures');
select oc_test.assert_that(oc_test.stored() = (select stored from oc_before), 'still nothing written');

drop schema cron cascade;
drop schema oc_test cascade;
rollback;
