-- Rollback-only T51a fixtures: every health check fails and recovers on cue, real booking flows leave
-- inventory consistent, and alert state posts changes, reminders and recoveries once confirmed. Runs on
-- PGlite and Docker without pg_cron (a stand-in cron schema lives only in this transaction); the real
-- pg_cron/pg_net/Edge path is ops-monitoring-local.cjs.
begin;
do $$ begin
  if to_regclass('cron.job') is not null then raise exception 'Run ops-monitoring.sql without pg_cron; the local harness installs it afterwards'; end if;
end $$;
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, schedule text not null, command text not null, nodename text not null default 'localhost',
  nodeport integer not null default 5432, database text not null default current_database(), username text not null default current_user,
  active boolean not null default true, jobname text);
create table cron.job_run_details (jobid bigint, runid bigserial primary key, job_pid integer, database text, username text, command text,
  status text not null, return_message text, start_time timestamptz, end_time timestamptz);
-- Other local harnesses' served functions leave signals behind; this transaction starts quiet (and rolls back).
delete from private.ops_signals;
delete from private.ops_alert_state;

create schema ops_test;
create function ops_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Ops monitoring assertion failed: %', message; end if; end; $$;
create function ops_test.expect_error(statement text, code text, hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint = pg_exception_hint;
    if sqlstate = code and (hint is null or actual_hint = hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %', code, hint, sqlstate, actual_hint, sqlerrm;
  end;
  raise exception 'Expected failure: %', statement;
end; $$;
create function ops_test.u(n text) returns uuid language sql immutable as $$ select ('cd100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ops_test.c(n text) returns uuid language sql immutable as $$ select ('cd300000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ops_test.k(n text) returns uuid language sql immutable as $$ select ('cd500000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function ops_test.at(minute integer) returns timestamptz language sql stable as $$
  select (((now() at time zone 'Asia/Manila')::date + 2)::timestamp + minute * interval '1 minute') at time zone 'Asia/Manila'; $$;
create function ops_test.rent(actor text, court text, request text, a integer, b integer) returns uuid language sql as $$
  select (public.rental_booking_request(ops_test.u(actor), ops_test.c(court), ops_test.k(request), ops_test.at(a), ops_test.at(b),
    public.rental_booking_quote(ops_test.u(actor), ops_test.c(court), ops_test.at(a), ops_test.at(b))->'expected_quote')->'booking'->>'id')::uuid; $$;
create function ops_test.change(actor text, booking uuid, command text) returns text language sql as $$
  select public.rental_booking_change(ops_test.u(actor), booking, command)->'booking'->>'status'; $$;
create function ops_test.group_change(actor text, booking uuid, command text) returns text language sql as $$
  select public.session_booking_change(ops_test.u(actor), booking, command)->'booking'->>'status'; $$;
create function ops_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
  select id from private.open_play_sessions where request_id = ops_test.k(request); $$;
create function ops_test.join_play(actor text, session_request text, request text, names jsonb, total bigint) returns uuid language sql as $$
  select (public.session_booking_request(ops_test.u(actor), jsonb_build_object('session_id', ops_test.sid(session_request),
    'request_id', ops_test.k(request), 'participants', names, 'expected_total_centavos', total))->'booking'->>'id')::uuid; $$;
create function ops_test.policy(confirmation text) returns void language sql security definer as $$
  insert into private.venue_policies(venue_id, confirmation, payment) values ('cd200000-0000-4000-8000-000000000001', confirmation, 'arrival')
  on conflict (venue_id) do update set confirmation = excluded.confirmation, revision = private.venue_policies.revision + 1; $$;
-- Non-ok checks as {"name":"status:count"}; every fixture asserts the whole set, so nothing else moved.
create function ops_test.problems() returns jsonb language sql security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(c->>'check', (c->>'status')||':'||(c->>'count')), '{}')
  from jsonb_array_elements(private.ops_health(clock_timestamp())) c where c->>'status' <> 'ok'; $$;
create function ops_test.expect(expected jsonb, message text) returns void language plpgsql as $$
declare actual jsonb := ops_test.problems();
begin
  if actual is distinct from expected then raise exception 'Ops monitoring assertion failed: % (expected %, got %)', message, expected, actual; end if;
end; $$;
-- One monitor run with the given Redis checks, as "check:status<previous:count" in check order.
create function ops_test.run(external jsonb default '[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.isolation","status":"ok","count":0}]')
returns text language sql as $$
  select coalesce(string_agg((a->>'check')||':'||(a->>'status')||'<'||(a->>'previous')||':'||(a->>'count'), ' ' order by a->>'check'), '')
  from jsonb_array_elements(public.ops_monitor_run(external)->'alerts') a; $$;
create function ops_test.confirm_due() returns integer language sql as $$
  select (public.ops_alerts_confirm(public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.isolation","status":"ok","count":0}]')->'alerts')->>'confirmed')::integer; $$;
create function ops_test.is(actual text, expected text, message text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'Ops monitoring assertion failed: % (expected "%", got "%")', message, expected, actual; end if;
end; $$;
-- Trusted SQL stands in for time passing and for operator mistakes.
create function ops_test.elapse_hold(booking uuid, ago interval) returns void language plpgsql security definer as $$
begin
  update private.court_allocations set expires_at = clock_timestamp() - ago where id = booking;
  if not found then
    alter table private.session_bookings disable trigger session_booking_guard;
    update private.session_bookings set expires_at = clock_timestamp() - ago where id = booking;
    alter table private.session_bookings enable trigger session_booking_guard;
  end if;
end; $$;
grant usage on schema ops_test to anon, authenticated, service_role;
grant execute on all functions in schema ops_test to anon, authenticated, service_role;

-- Only the service role reaches the three public commands; nothing reaches the private helpers or tables.
select ops_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname in ('public','private') and p.proname like 'ops\_%' and has_function_privilege(r.name, p.oid, 'execute')), 'no client role executes ops functions');
select ops_test.assert_that((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.proname like 'ops\_%' and has_function_privilege('service_role', p.oid, 'execute'))
  = array['ops_alerts_confirm','ops_monitor_run','ops_signal_record'], 'service role executes exactly the three commands');
select ops_test.assert_that(not exists(select 1 from information_schema.role_table_grants g
  where g.table_schema = 'private' and g.table_name in ('ops_signals','ops_alert_state') and g.grantee in ('anon','authenticated','service_role')),
  'ops tables have no API grants');
set local role authenticated;
select ops_test.expect_error($$select public.ops_signal_record('venue-search','server_error',1)$$, '42501');
select ops_test.expect_error($$select public.ops_monitor_run('[]')$$, '42501');
select ops_test.expect_error($$select public.ops_alerts_confirm('[]')$$, '42501');
reset role;
set local role service_role;
select ops_test.expect_error('select private.ops_health(clock_timestamp())', '42501');
select ops_test.expect_error('select private.ops_monitor_kick()', '42501');
select ops_test.expect_error('select count(*) from private.ops_signals', '42501');
-- Signals: fixed sources, kinds and bounds.
select ops_test.expect_error($$select public.ops_signal_record('ops-monitor','server_error',1)$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_signal_record('venue-search','timeout',1)$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_signal_record('venue-search','server_error',0)$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_signal_record('venue-search','server_error',10001)$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_signal_record(null,'server_error',1)$$, '22023', 'invalid_input');
reset role;

-- Fixtures: an owner (1), two players (2, 3), a deleting account (4); three courts; all-day hours.
insert into auth.users(id) select ops_test.u(n::text) from generate_series(1, 4) n;
insert into public.venues(id, name, address_line, city, province, latitude, longitude, publication_status, claim_status) values
  ('cd200000-0000-4000-8000-000000000001', 'Ops Fixture', 'Fixture', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'verified');
insert into public.courts(id, venue_id, name, status) select ops_test.c(n::text), 'cd200000-0000-4000-8000-000000000001', chr(64 + n), 'active' from generate_series(1, 3) n;
insert into private.venue_owners(user_id, venue_id) values (ops_test.u('1'), 'cd200000-0000-4000-8000-000000000001');
select public.venue_schedule_save(ops_test.u('1'), 'cd200000-0000-4000-8000-000000000001', null,
  jsonb_build_object('weekly', (select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute', 0, 'end_minute', 1440, 'rates', jsonb_build_array(
    jsonb_build_object('start_minute', 0, 'end_minute', 1440, 'hourly_centavos', 40000))))) from generate_series(1, 7)), 'exceptions', '[]'::jsonb));
-- The four jobs, each with a recent successful run.
insert into cron.job(jobname, schedule, command) values ('booking-expiry-sweep', '* * * * *', 'select private.booking_expiry_sweep(100)'),
  ('push-dispatch', '* * * * *', 'select private.push_dispatch_kick()'), ('privacy-retention-sweep', '17 19 * * *', 'select private.privacy_retention_sweep(500)'),
  ('ops-monitor', '*/5 * * * *', 'select private.ops_monitor_kick()');
insert into cron.job_run_details(jobid, status, start_time, end_time) select jobid, 'succeeded', clock_timestamp() - interval '1 minute', clock_timestamp() from cron.job;
select ops_test.expect('{}', 'baseline: every check ok');

-- Real flows leave inventory consistent: instant and approval rentals, accept/decline/cancel, groups, walk-ins and
-- an occupied session cancelled by the venue (T40a).
select ops_test.policy('instant');
create temporary table ops_flow(name text primary key, id uuid) on commit drop;
insert into ops_flow values ('instant', ops_test.rent('2', '1', '01', 480, 540)), ('instant_cancel', ops_test.rent('2', '1', '02', 540, 600));
select ops_test.is(ops_test.change('2', (select id from ops_flow where name = 'instant_cancel'), 'cancel'), 'cancelled', 'player cancels');
select ops_test.policy('approval');
insert into ops_flow values ('pending', ops_test.rent('2', '2', '03', 480, 540)), ('accepted', ops_test.rent('3', '2', '04', 540, 600)),
  ('declined', ops_test.rent('3', '2', '05', 600, 660));
select ops_test.is(ops_test.change('1', (select id from ops_flow where name = 'accepted'), 'accept'), 'confirmed', 'owner accepts');
select ops_test.is(ops_test.change('1', (select id from ops_flow where name = 'declined'), 'decline'), 'declined', 'owner declines');
select ops_test.policy('instant');
select public.owner_session_create(ops_test.u('1'), jsonb_build_object('venue_id', 'cd200000-0000-4000-8000-000000000001', 'request_id', ops_test.k(n),
  'court_ids', jsonb_build_array(ops_test.c('3')), 'title', 'Ops play', 'starts_at', ops_test.at(a), 'ends_at', ops_test.at(b),
  'capacity', 8, 'group_limit', 4, 'price_centavos', 20000)) from (values ('10', 600, 720), ('11', 780, 900)) v(n, a, b);
insert into ops_flow values ('group', ops_test.join_play('2', '10', '12', '["Ana","Ben"]', 40000)), ('group_cancel', ops_test.join_play('3', '10', '13', '["Cy"]', 20000)),
  ('other_group', ops_test.join_play('2', '11', '14', '["Dee","Eli","Fay"]', 60000));
select ops_test.is(ops_test.group_change('3', (select id from ops_flow where name = 'group_cancel'), 'cancel'), 'cancelled', 'player cancels a group');
select public.session_walk_in(ops_test.u('1'), jsonb_build_object('session_id', ops_test.sid('10'), 'request_id', ops_test.k('15'),
  'participants', '["Gus"]'::jsonb, 'expected_total_centavos', 20000));
select public.owner_session_cancel(ops_test.u('1'), ops_test.sid('11'), 'weather');
select ops_test.assert_that((select reserved_spots from private.open_play_sessions where id = ops_test.sid('10')) = 3, 'session 10 holds Ana, Ben and Gus');
select ops_test.expect('{}', 'real flows: no inventory mismatch');

-- Scheduled jobs.
update cron.job set active = false where jobname = 'push-dispatch';
select ops_test.expect('{"cron.jobs":"fail:1"}', 'an inactive job');
delete from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'ops-monitor');
delete from cron.job where jobname = 'ops-monitor';
select ops_test.expect('{"cron.jobs":"fail:2"}', 'a missing job too');
update cron.job set active = true where jobname = 'push-dispatch';
insert into cron.job(jobname, schedule, command) values ('ops-monitor', '*/5 * * * *', 'select private.ops_monitor_kick()');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() - interval '2 minutes' from cron.job where jobname = 'push-dispatch';
select ops_test.expect('{"cron.failures":"warn:1"}', 'one failed run');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() - interval '3 minutes' from cron.job where jobname in ('booking-expiry-sweep','ops-monitor');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() - interval '16 minutes' from cron.job where jobname = 'push-dispatch';
-- A failed run of a job the monitor does not know about is not counted.
insert into cron.job(jobname, schedule, command) values ('someone-else', '* * * * *', 'select 1');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() from cron.job where jobname = 'someone-else';
select ops_test.expect('{"cron.failures":"fail:3"}', 'three failed runs in 15 minutes; older and unknown ones ignored');
delete from cron.job_run_details where status = 'failed';
update cron.job_run_details set start_time = clock_timestamp() - interval '11 minutes' where jobid = (select jobid from cron.job where jobname = 'push-dispatch');
update cron.job_run_details set start_time = clock_timestamp() - interval '2 days' where jobid = (select jobid from cron.job where jobname = 'privacy-retention-sweep');
select ops_test.expect('{"cron.stalled":"fail:1"}', 'an every-minute job without a success in 10 minutes; the daily job is not judged on age');
update cron.job_run_details set start_time = clock_timestamp() - interval '9 minutes' where jobid = (select jobid from cron.job where jobname = 'push-dispatch');
select ops_test.expect('{}', 'a success 9 minutes ago is fine');
alter schema cron rename to cron_hidden;
select ops_test.expect('{"cron.jobs":"fail:4"}', 'no pg_cron: every job missing, run checks skipped');
alter schema cron_hidden rename to cron;

-- Holds the sweep should have recorded.
-- Session 16 snapshots the approval policy, so its groups are holds.
select ops_test.policy('approval');
select public.owner_session_create(ops_test.u('1'), jsonb_build_object('venue_id', 'cd200000-0000-4000-8000-000000000001', 'request_id', ops_test.k('16'),
  'court_ids', jsonb_build_array(ops_test.c('3')), 'title', 'Ops approval play', 'starts_at', ops_test.at(960), 'ends_at', ops_test.at(1080),
  'capacity', 8, 'group_limit', 4, 'price_centavos', 20000));
insert into ops_flow values ('hold', ops_test.rent('3', '1', '20', 600, 660)), ('group_hold', ops_test.join_play('3', '16', '21', '["Hal"]', 20000));
select ops_test.assert_that((select status from private.session_bookings where id = (select id from ops_flow where name = 'group_hold')) = 'pending', 'the group is a hold');
select ops_test.elapse_hold((select id from ops_flow where name = 'hold'), interval '9 minutes');
select ops_test.elapse_hold((select id from ops_flow where name = 'group_hold'), interval '9 minutes');
select ops_test.expect('{}', 'elapsed 9 minutes ago: still within the sweep''s grace');
select ops_test.elapse_hold((select id from ops_flow where name = 'hold'), interval '11 minutes');
select ops_test.elapse_hold((select id from ops_flow where name = 'group_hold'), interval '11 minutes');
select ops_test.expect('{"holds.overdue":"fail:2"}', 'a rental and a group hold overdue');
select private.booking_expiry_sweep(100);
select ops_test.expect('{}', 'the sweep clears both and inventory still agrees');

-- Inventory that disagrees with bookings, one corruption at a time (trusted SQL).
update private.open_play_sessions set reserved_spots = reserved_spots + 1 where id = ops_test.sid('10');
select ops_test.expect('{"inventory.mismatch":"fail:1"}', 'a session counter above its live groups');
update private.open_play_sessions set reserved_spots = reserved_spots - 1 where id = ops_test.sid('10');
update private.court_allocations set state = 'released', ended_at = clock_timestamp() where id = (select id from ops_flow where name = 'accepted');
select ops_test.expect('{"inventory.mismatch":"fail:1"}', 'a confirmed rental without its court');
update private.court_allocations set state = 'active', ended_at = null where id = (select id from ops_flow where name = 'accepted');
update private.court_allocations set state = 'active', ended_at = null where id = (select id from ops_flow where name = 'instant_cancel');
select ops_test.expect('{"inventory.mismatch":"fail:1"}', 'a cancelled rental still holding its court');
update private.court_allocations set state = 'released', ended_at = clock_timestamp() where id = (select id from ops_flow where name = 'instant_cancel');
update private.court_allocations set expires_at = clock_timestamp() + interval '1 hour' where id = (select id from ops_flow where name = 'instant');
select ops_test.expect('{"inventory.mismatch":"fail:1"}', 'a confirmed rental on a hold instead of firm');
update private.court_allocations set expires_at = null where id = (select id from ops_flow where name = 'instant');
insert into private.court_allocations(venue_id, court_id, kind, starts_at, ends_at, requested_by, request_id)
  values ('cd200000-0000-4000-8000-000000000001', ops_test.c('1'), 'rental', ops_test.at(1200), ops_test.at(1260), ops_test.u('2'), ops_test.k('30')),
    ('cd200000-0000-4000-8000-000000000001', ops_test.c('2'), 'session', ops_test.at(1200), ops_test.at(1260), ops_test.u('1'), ops_test.k('31'));
select ops_test.expect('{"inventory.mismatch":"fail:2"}', 'rental and session inventory with no booking or session');
delete from private.court_allocations where request_id in (ops_test.k('30'), ops_test.k('31'));
update private.court_allocations set state = 'released', ended_at = clock_timestamp()
  where id = (select allocation_id from private.session_courts where session_id = ops_test.sid('10'));
select ops_test.expect('{"inventory.mismatch":"fail:1"}', 'a scheduled session whose court was released');
update private.court_allocations set state = 'active', ended_at = null
  where id = (select allocation_id from private.session_courts where session_id = ops_test.sid('10'));
-- Old rows are out of scope: the same corruption on a rental that ended three days ago is not counted.
update private.court_allocations set starts_at = starts_at - interval '6 days', ends_at = ends_at - interval '6 days', expires_at = null, state = 'active', ended_at = null
  where id = (select id from ops_flow where name = 'declined');
select ops_test.expect('{}', 'rows that ended over two days ago are not judged');

-- Push outbox.
insert into private.notification_outbox(source, event_id, recipient_user_id, kind, payload, next_attempt_at)
  values ('rental', 9001, ops_test.u('2'), 'booking.accepted', '{}', clock_timestamp() - interval '9 minutes');
select ops_test.expect('{}', 'a row due 9 minutes ago is still fresh');
update private.notification_outbox set next_attempt_at = clock_timestamp() - interval '11 minutes' where event_id = 9001;
select ops_test.expect('{"push.backlog":"fail:1"}', 'a row waiting 11 minutes');
update private.notification_outbox set status = 'sending', claim_id = gen_random_uuid(), locked_until = clock_timestamp() - interval '11 minutes' where event_id = 9001;
select ops_test.expect('{"push.backlog":"fail:1"}', 'a lease that expired 11 minutes ago');
update private.notification_outbox set status = 'failed', claim_id = null, locked_until = null, last_error = 'retries_exhausted', finished_at = clock_timestamp() where event_id = 9001;
select ops_test.expect('{"push.failures":"warn:1"}', 'a row that failed this hour');
update private.notification_outbox set last_error = 'invalid_credentials' where event_id = 9001;
select ops_test.expect('{"push.credentials":"fail:1"}', 'a credential failure');
update private.notification_outbox set status = 'sent', last_error = null where event_id = 9001;
insert into private.push_devices(id, user_id, token, platform) values ('cd600000-0000-4000-8000-000000000001', ops_test.u('2'), 'ExponentPushToken[ops-fixture]', 'ios');
insert into private.push_deliveries(outbox_id, device_id, ticket_id, receipt, receipt_error)
  select id, 'cd600000-0000-4000-8000-000000000001', 'ops-ticket-1', 'error', 'device_not_registered' from private.notification_outbox where event_id = 9001;
select ops_test.expect('{}', 'an unregistered device is routine');
update private.push_deliveries set receipt_error = 'message_too_big' where ticket_id = 'ops-ticket-1';
select ops_test.expect('{"push.failures":"warn:1"}', 'a failed receipt');
delete from private.push_deliveries where ticket_id = 'ops-ticket-1';

-- Edge signals: the last 15 minutes only.
set local role service_role;
select public.ops_signal_record('rental-bookings', 'server_error', 1);
reset role;
select ops_test.expect('{"edge.errors":"warn:1"}', 'one server error');
set local role service_role;
select public.ops_signal_record('venue-search', 'server_error', 4), public.ops_signal_record('push-dispatch', 'unavailable', 5),
  public.ops_signal_record('venue-search', 'limiter_degraded', 1);
reset role;
select ops_test.expect('{"edge.errors":"fail:5","edge.unavailable":"warn:5","edge.limiter":"fail:1"}', 'errors, 503s and limiter outages add up');
select ops_test.assert_that((select occurrences from private.ops_signals where source = 'venue-search' and kind = 'server_error') = 4, 'one row per minute, source and kind');
set local role service_role;
select public.ops_signal_record('session-bookings', 'unavailable', 20);
reset role;
select ops_test.expect('{"edge.errors":"fail:5","edge.unavailable":"fail:25","edge.limiter":"fail:1"}', '25 503s fail');
update private.ops_signals set minute = date_trunc('minute', clock_timestamp()) - interval '16 minutes';
select ops_test.expect('{}', 'signals older than 15 minutes are ignored');

-- Account deletions that did not finish.
insert into private.account_deletions(user_id, requested_at) values (ops_test.u('4'), clock_timestamp() - interval '59 minutes');
select ops_test.expect('{}', 'a deletion under an hour old');
update private.account_deletions set requested_at = clock_timestamp() - interval '61 minutes' where user_id = ops_test.u('4');
select ops_test.expect('{"privacy.deletions":"fail:1"}', 'over an hour and the Auth user is still there');
delete from auth.users where id = ops_test.u('4');
select ops_test.expect('{}', 'the Auth user is gone: deletion finished');

-- Arrival-only pilot.
insert into private.venue_merchants(venue_id, active) values ('cd200000-0000-4000-8000-000000000001', true);
select ops_test.expect('{"rollout.arrival_only":"fail:1"}', 'an active merchant');
update private.venue_policies set payment = 'online' where venue_id = 'cd200000-0000-4000-8000-000000000001';
select ops_test.expect('{"rollout.arrival_only":"fail:2"}', 'and a stored online policy');
update private.venue_policies set payment = 'arrival' where venue_id = 'cd200000-0000-4000-8000-000000000001';
update private.venue_merchants set active = false;
select ops_test.expect('{}', 'an inactive merchant record alone is fine');
alter table private.rental_snapshots disable trigger rental_snapshot_immutable;
update private.rental_snapshots set snapshot = jsonb_set(snapshot, '{policy,payment}', '"online"') where allocation_id = (select id from ops_flow where name = 'instant');
alter table private.rental_snapshots enable trigger rental_snapshot_immutable;
select ops_test.expect('{"rollout.arrival_only":"fail:1"}', 'a live booking snapshot that offers online payment');
alter table private.rental_snapshots disable trigger rental_snapshot_immutable;
update private.rental_snapshots set snapshot = jsonb_set(snapshot, '{policy,payment}', '"arrival"') where allocation_id = (select id from ops_flow where name = 'instant');
alter table private.rental_snapshots enable trigger rental_snapshot_immutable;
select ops_test.expect('{}', 'everything restored');

-- Monitor runs: input validation.
select ops_test.expect_error($$select public.ops_monitor_run(null)$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('{}')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.isolation","status":"ok","count":0},{"check":"redis.reachable","status":"ok","count":0}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.reachable","status":"fail","count":1}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"holds.overdue","status":"ok","count":0}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"bad","count":0}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":-1}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":1.5}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":"1"}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok"}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0,"note":"x"}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_alerts_confirm('{}')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_alerts_confirm('[{"check":"Holds","status":"ok"}]')$$, '22023', 'invalid_input');
select ops_test.expect_error($$select public.ops_alerts_confirm('[{"check":"holds.overdue","status":"maybe"}]')$$, '22023', 'invalid_input');

-- Alert state: a quiet first run posts nothing; a problem posts until confirmed; then only changes, reminders and recovery.
select ops_test.is(ops_test.run(), '', 'all ok: nothing to post');
select ops_test.assert_that((select count(*) from private.ops_alert_state) = 15, 'all thirteen database checks and both Redis checks are tracked');
select ops_test.policy('approval');
insert into ops_flow values ('late_hold', ops_test.rent('3', '1', '40', 660, 720));
select ops_test.elapse_hold((select id from ops_flow where name = 'late_hold'), interval '11 minutes');
select ops_test.is(ops_test.run(), 'holds.overdue:fail<ok:1', 'a new problem');
create temporary table ops_since on commit drop as select since from private.ops_alert_state where check_name = 'holds.overdue';
select ops_test.is(ops_test.run(), 'holds.overdue:fail<ok:1', 'still due: nothing was confirmed');
select ops_test.is(ops_test.confirm_due()::text, '1', 'confirmed after the post');
select ops_test.is(ops_test.run(), '', 'confirmed: no repeat');
insert into ops_flow values ('late_hold_2', ops_test.rent('3', '2', '41', 660, 720));
select ops_test.elapse_hold((select id from ops_flow where name = 'late_hold_2'), interval '11 minutes');
select ops_test.is(ops_test.run(), '', 'a larger count of the same problem is not a change');
select ops_test.assert_that((select observed from private.ops_alert_state where check_name = 'holds.overdue') = 2, 'the count is kept current');
update private.ops_alert_state set notified_at = clock_timestamp() - interval '6 hours 1 second' where check_name = 'holds.overdue';
select ops_test.is(ops_test.run(), 'holds.overdue:fail<fail:2', 'six hours later: a reminder');
select ops_test.assert_that((select since from private.ops_alert_state where check_name = 'holds.overdue') = (select since from ops_since), 'since is the first failing run');
select ops_test.is(ops_test.confirm_due()::text, '1', 'reminder confirmed');
select ops_test.is(ops_test.run(), '', 'no repeat after the reminder');
-- Severity change, then a check that changes again between run and confirmation is left for the next run.
update cron.job set active = false where jobname = 'push-dispatch';
select ops_test.is(ops_test.run(), 'cron.jobs:fail<ok:1', 'a second problem');
create temporary table ops_stale on commit drop as select public.ops_monitor_run('[{"check":"redis.reachable","status":"ok","count":0}]')->'alerts' alerts;
select ops_test.assert_that((select jsonb_array_length(alerts) from ops_stale) = 1, 'the unposted problem is due again');
update cron.job set active = true where jobname = 'push-dispatch';
select ops_test.is(ops_test.run(), '', 'the job came back before any post, so there is nothing to say');
select ops_test.is((public.ops_alerts_confirm((select alerts from ops_stale))->>'confirmed'), '0', 'a late confirmation of the old state changes nothing');
select ops_test.is(ops_test.run(), '', 'still nothing to say');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() - interval '1 minute' from cron.job where jobname = 'push-dispatch';
select ops_test.is(ops_test.run(), 'cron.failures:warn<ok:1', 'a warning');
select ops_test.is(ops_test.confirm_due()::text, '1', 'warning confirmed');
insert into cron.job_run_details(jobid, status, start_time) select jobid, 'failed', clock_timestamp() - interval '1 minute' from cron.job where jobname in ('push-dispatch','booking-expiry-sweep');
select ops_test.is(ops_test.run(), 'cron.failures:fail<warn:3', 'escalated from warn to fail');
select ops_test.is(ops_test.confirm_due()::text, '1', 'escalation confirmed');
-- Recovery posts once.
delete from cron.job_run_details where status = 'failed';
select private.booking_expiry_sweep(100);
select ops_test.is(ops_test.run(), 'cron.failures:ok<fail:0 holds.overdue:ok<fail:0', 'two recoveries');
select ops_test.is(ops_test.confirm_due()::text, '2', 'recoveries confirmed');
select ops_test.is(ops_test.run(), '', 'quiet again');
-- Redis checks come from the function; a run without them leaves their state alone.
select ops_test.is(ops_test.run('[{"check":"redis.reachable","status":"fail","count":1}]'), 'redis.reachable:fail<ok:1', 'Redis down');
select ops_test.is((public.ops_alerts_confirm('[{"check":"redis.reachable","status":"fail"}]')->>'confirmed'), '1', 'Redis alert confirmed');
select ops_test.is(ops_test.run('[]'), '', 'no Redis checks this run: nothing changes');
select ops_test.assert_that((select status from private.ops_alert_state where check_name = 'redis.reachable') = 'fail', 'Redis state kept');
select ops_test.is(ops_test.run('[{"check":"redis.reachable","status":"ok","count":0},{"check":"redis.isolation","status":"fail","count":1}]'),
  'redis.isolation:fail<ok:1 redis.reachable:ok<fail:0', 'Redis back, but shared with another environment');
-- Runs prune signals older than two days.
insert into private.ops_signals(minute, source, kind, occurrences) values (date_trunc('minute', clock_timestamp()) - interval '3 days', 'venue-search', 'unavailable', 1);
select ops_test.run();
select ops_test.assert_that(not exists(select 1 from private.ops_signals where minute < clock_timestamp() - interval '2 days'), 'old signals pruned');
rollback;
