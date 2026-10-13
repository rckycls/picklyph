-- Rollback-only T51d fixtures: crash_report_record (grants, the strict contract, one row per report ID, the daily cap),
-- the app.crashes check (preview/production crashes and failed screens in the last hour), the admin-only
-- crash_admin_read (7-day groups, per-variant counts, the latest report, at most 50 groups, no writes) and the privacy
-- sweep's 30-day retention. Commands run as service_role (the function's and the console's client); assertions run as
-- the owner. PGlite and Docker.
begin;
-- Other local harnesses may leave reports behind; this transaction starts empty (and rolls back).
delete from private.app_crashes;

create schema cr_test;
grant usage on schema cr_test to anon, authenticated, service_role;
create function cr_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Crash report assertion failed: %', message; end if; end; $$;
create function cr_test.expect_error(statement text, code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = code then return; end if;
    raise exception 'Crash report assertion failed: expected %, got %: %', code, sqlstate, sqlerrm;
  end;
  raise exception 'Crash report assertion failed: expected failure: %', statement;
end; $$;
create function cr_test.u(n integer) returns uuid language sql immutable as $$ select format('c51d0000-0000-4000-8000-%s', lpad(n::text, 12, '0'))::uuid; $$;
create function cr_test.fp(n integer) returns text language sql immutable as $$ select encode(sha256(convert_to('fingerprint ' || n, 'UTF8')), 'hex'); $$;
-- A valid report as the function sends it, with fields replaced by `patch`.
create function cr_test.report(n integer, patch jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('id', cr_test.u(n), 'kind', 'fatal', 'name', 'TypeError', 'message', 'undefined is not a function',
    'stack', 'TypeError: undefined is not a function' || chr(10) || '    at anonymous (address at index.bundle:1:2345)', 'component_stack', null,
    'route', '/rental/venue/[id]', 'app_version', '0.1.0', 'variant', 'preview', 'os', 'ios', 'os_version', '18.6',
    'occurred_at', '2026-10-14T01:02:03.456Z', 'fingerprint', cr_test.fp(1)) || patch; $$;
create function cr_test.record(report jsonb) returns text language sql as $$ select public.crash_report_record(report)->>'outcome'; $$;
-- A stored row received `age` ago (fixtures straight into the table, as the owner).
create function cr_test.put(n integer, age interval, kind text default 'fatal', variant text default 'preview', fp integer default 1,
  message text default 'undefined is not a function') returns void language sql as $$
  insert into private.app_crashes (id, received_at, occurred_at, kind, fingerprint, name, message, stack, component_stack, route, app_version, variant, os, os_version)
    values (cr_test.u(n), clock_timestamp() - age, clock_timestamp() - age, kind, cr_test.fp(fp), 'TypeError', message, 'at a (index.bundle:1:' || n || ')',
      case when kind = 'render' then 'in VenueSheet' end, '/v/[id]', '0.1.' || n, variant, 'ios', '18.' || n); $$;
create function cr_test.check() returns jsonb language sql stable as $$
  select e from jsonb_array_elements(private.ops_health(clock_timestamp())) e where e->>'check' = 'app.crashes'; $$;
create function cr_test.group(view jsonb, fp integer) returns jsonb language sql immutable as $$
  select e from jsonb_array_elements(view->'groups') e where e->>'fingerprint' = cr_test.fp(fp); $$;
grant execute on all functions in schema cr_test to service_role;
create temporary table cr_view (name text primary key, view jsonb) on commit drop;
grant all on cr_view to service_role;
create function cr_test.view(text) returns jsonb language sql stable as $$ select v.view from cr_view v where v.name = $1; $$;

-- Accounts: admin (1), moderator (2), player (3).
insert into auth.users(id) values (cr_test.u(9001)), (cr_test.u(9002)), (cr_test.u(9003));
insert into private.account_roles(user_id, role) values (cr_test.u(9001), 'admin'), (cr_test.u(9002), 'moderator');

-- Grants: only the service role records and reads; nobody reads the table directly.
select cr_test.assert_that(not has_function_privilege('anon', 'public.crash_report_record(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.crash_report_record(jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.crash_report_record(jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.crash_admin_read(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.crash_admin_read(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.crash_admin_read(uuid)', 'execute'), 'only the service role records and reads');
select cr_test.assert_that(not has_table_privilege('anon', 'private.app_crashes', 'select')
  and not has_table_privilege('authenticated', 'private.app_crashes', 'select')
  and not has_table_privilege('service_role', 'private.app_crashes', 'select,insert,update,delete'), 'no direct table access');
set local role anon;
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(1)), '42501');
reset role;
set local role authenticated;
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(1)), '42501');
select cr_test.expect_error(format('select public.crash_admin_read(%L)', cr_test.u(9001)), '42501');
reset role;

-- A report is stored once, exactly as sent; a resent report (same ID) is not stored again.
set local role service_role;
select cr_test.assert_that(cr_test.record(cr_test.report(1)) = 'stored', 'stored');
select cr_test.assert_that(cr_test.record(cr_test.report(1, '{"message":"changed"}')) = 'existing', 'a resent report is recognised');
select cr_test.assert_that(cr_test.record(cr_test.report(2, '{"kind":"render","component_stack":"in VenueSheet","stack":null,"route":null}')) = 'stored',
  'a render error with a component stack, no stack and no route');
reset role;
select cr_test.assert_that((select count(*) from private.app_crashes) = 2, 'two rows');
select cr_test.assert_that((select to_jsonb(c) - 'received_at' from private.app_crashes c where c.id = cr_test.u(1)) = jsonb_build_object(
    'id', cr_test.u(1), 'occurred_at', '2026-10-14T01:02:03.456+00:00'::timestamptz, 'kind', 'fatal', 'fingerprint', cr_test.fp(1),
    'name', 'TypeError', 'message', 'undefined is not a function',
    'stack', 'TypeError: undefined is not a function' || chr(10) || '    at anonymous (address at index.bundle:1:2345)',
    'component_stack', null, 'route', '/rental/venue/[id]', 'app_version', '0.1.0', 'variant', 'preview', 'os', 'ios', 'os_version', '18.6'),
  'the first report is kept as sent');
select cr_test.assert_that((select received_at from private.app_crashes where id = cr_test.u(1)) between clock_timestamp() - interval '1 minute' and clock_timestamp(),
  'received now, by the server clock');

-- Anything off the contract is refused with invalid_input, and nothing is stored.
set local role service_role;
select cr_test.expect_error('select public.crash_report_record(null)', '22023');
select cr_test.expect_error($q$select public.crash_report_record('[]')$q$, '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3) - 'route'), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"account":"x"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"name":7}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"message":null}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"stack":{"frames":[]}}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"id":"not-a-uuid"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"id":"C51D0000-0000-4000-8000-000000000003"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"occurred_at":"yesterday"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"occurred_at":"2026-13-40T00:00:00Z"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"kind":"warning"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"fingerprint":"abc"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"name":"   "}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, jsonb_build_object('message', repeat('m', 501)))), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, jsonb_build_object('stack', repeat('s', 6001)))), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"component_stack":"in X"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"route":"rental"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"route":"/v?id=1"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"app_version":"1.0 beta"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"variant":"staging"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"os":"web"}')), '22023');
select cr_test.expect_error(format('select public.crash_report_record(%L)', cr_test.report(3, '{"os_version":"18;drop"}')), '22023');
reset role;
select cr_test.assert_that((select count(*) from private.app_crashes) = 2, 'refused reports store nothing');
-- The same values are accepted at their limits.
set local role service_role;
select cr_test.assert_that(cr_test.record(cr_test.report(4, jsonb_build_object('message', repeat('m', 500), 'stack', repeat('s', 6000),
  'name', repeat('n', 100), 'route', '/' || repeat('r', 199)))) = 'stored', 'every field at its limit');
reset role;

-- app.crashes: fatal and render reports from preview and production builds received in the last hour.
delete from private.app_crashes;
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"ok","count":0}', 'quiet');
select cr_test.put(10, interval '30 minutes');
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"warn","count":1}', 'one preview crash warns');
select cr_test.put(11, interval '10 minutes', 'fatal', 'development');
select cr_test.put(12, interval '10 minutes', 'error', 'production');
select cr_test.put(13, interval '61 minutes', 'fatal', 'production');
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"warn","count":1}',
  'development builds, non-fatal errors and crashes over an hour old do not count');
select cr_test.put(14, interval '5 minutes', 'render', 'production');
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"warn","count":2}', 'a failed screen counts');
select cr_test.put(20 + n, interval '1 minute', 'fatal', 'production') from generate_series(1, 7) n;
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"warn","count":9}', 'nine still warn');
select cr_test.put(30, interval '1 minute', 'fatal', 'production');
select cr_test.assert_that(cr_test.check() = '{"check":"app.crashes","status":"fail","count":10}', 'ten fail');
select cr_test.assert_that((select count(*) from jsonb_array_elements(private.ops_health(clock_timestamp())) e where e->>'check' = 'app.crashes') = 1,
  'one app.crashes check');

-- The daily cap: 2,000 reports received in the last 24 hours; older ones and resends do not count.
delete from private.app_crashes;
insert into private.app_crashes (id, received_at, occurred_at, kind, fingerprint, name, message, app_version, variant, os, os_version)
  select cr_test.u(100 + n), clock_timestamp() - interval '23 hours', clock_timestamp(), 'error', cr_test.fp(2), 'Error', 'm', '0.1.0', 'development', 'ios', '18'
  from generate_series(1, 1998) n;
set local role service_role;
select cr_test.assert_that(cr_test.record(cr_test.report(5)) = 'stored', '1,999th stored');
select cr_test.assert_that(cr_test.record(cr_test.report(6)) = 'stored', '2,000th stored');
select cr_test.assert_that(cr_test.record(cr_test.report(7)) = 'capped', 'the 2,001st is not');
select cr_test.assert_that(cr_test.record(cr_test.report(5)) = 'existing', 'a resend of a stored report is still recognised');
reset role;
select cr_test.assert_that(not exists (select 1 from private.app_crashes where id = cr_test.u(7)), 'the capped report is not stored');
update private.app_crashes set received_at = clock_timestamp() - interval '25 hours' where id = cr_test.u(101);
set local role service_role;
select cr_test.assert_that(cr_test.record(cr_test.report(7)) = 'stored', 'a day later there is room again');
reset role;

-- The console: administrators only (rechecked in the database).
delete from private.app_crashes;
set local role service_role;
select cr_test.expect_error(format('select public.crash_admin_read(%L)', cr_test.u(9002)), '42501');
select cr_test.expect_error(format('select public.crash_admin_read(%L)', cr_test.u(9003)), '42501');
select cr_test.expect_error(format('select public.crash_admin_read(%L)', cr_test.u(9999)), '42501');
select cr_test.expect_error('select public.crash_admin_read(null)', '42501');
insert into cr_view values ('empty', public.crash_admin_read(cr_test.u(9001)));
reset role;
select cr_test.assert_that((select array_agg(k order by k) from jsonb_object_keys(cr_test.view('empty')) k) = array['at','days','groups','total']
  and cr_test.view('empty')->'groups' = '[]' and cr_test.view('empty')->'total' = '0' and cr_test.view('empty')->'days' = '7'
  and (cr_test.view('empty')->>'at')::timestamptz <= clock_timestamp(), 'an empty week');

-- Groups by fingerprint over 7 days: counts per variant, first and last seen, the latest report's details.
select cr_test.put(40, interval '3 days', 'fatal', 'preview', 1, 'oldest message');
select cr_test.put(41, interval '2 days', 'fatal', 'production', 1, 'middle message');
select cr_test.put(42, interval '1 hour', 'fatal', 'development', 1, 'latest message');
select cr_test.put(43, interval '7 days 12 hours', 'fatal', 'production', 1, 'too old');
select cr_test.put(44, interval '5 hours', 'render', 'production', 2, 'render failure');
select cr_test.put(45, interval '10 days', 'error', 'preview', 3, 'only old');
select cr_test.put(46, interval '6 days', 'fatal', 'production', 1, 'earliest this week');
set local role service_role;
insert into cr_view values ('week', public.crash_admin_read(cr_test.u(9001)));
reset role;
select cr_test.assert_that(cr_test.view('week')->'total' = '5', 'five reports this week');
select cr_test.assert_that(jsonb_array_length(cr_test.view('week')->'groups') = 2 and cr_test.group(cr_test.view('week'), 3) is null,
  'two groups; a group seen only before the week is left out');
select cr_test.assert_that((select array_agg(e->>'fingerprint' order by n) from jsonb_array_elements(cr_test.view('week')->'groups') with ordinality g(e, n))
  = array[cr_test.fp(1), cr_test.fp(2)], 'most recently seen first');
select cr_test.assert_that(cr_test.group(cr_test.view('week'), 1) = (select jsonb_build_object('fingerprint', cr_test.fp(1), 'kind', 'fatal',
    'name', 'TypeError', 'message', 'latest message', 'reports', 4, 'development', 1, 'preview', 1, 'production', 2,
    'first_seen', (select received_at from private.app_crashes where id = cr_test.u(46)),
    'last_seen', (select received_at from private.app_crashes where id = cr_test.u(42)),
    'app_version', '0.1.42', 'os', 'ios', 'os_version', '18.42', 'route', '/v/[id]', 'stack', 'at a (index.bundle:1:42)', 'component_stack', null)),
  'counts per variant, first and last seen in the week, the latest report''s details');
select cr_test.assert_that(cr_test.group(cr_test.view('week'), 2)->>'component_stack' = 'in VenueSheet'
  and cr_test.group(cr_test.view('week'), 2)->>'kind' = 'render', 'a render group carries its component stack');
-- At most 50 groups; the total still counts every report.
select cr_test.put(1000 + n, make_interval(mins => n), 'error', 'preview', 100 + n) from generate_series(1, 52) n;
set local role service_role;
insert into cr_view values ('many', public.crash_admin_read(cr_test.u(9001)));
reset role;
select cr_test.assert_that(jsonb_array_length(cr_test.view('many')->'groups') = 50 and cr_test.view('many')->'total' = '57', 'fifty groups, every report counted');
select cr_test.assert_that(cr_test.group(cr_test.view('many'), 101) is not null and cr_test.group(cr_test.view('many'), 3) is null
  and cr_test.group(cr_test.view('many'), 1) is null and cr_test.group(cr_test.view('many'), 150) is not null, 'the fifty most recently seen');
select cr_test.assert_that((select array_agg(e->>'fingerprint' order by n) from jsonb_array_elements(cr_test.view('many')->'groups') with ordinality g(e, n))
  = (select array_agg(cr_test.fp(100 + n) order by n) from generate_series(1, 50) n), 'in the order they were last seen');
-- A read writes nothing.
create temporary table cr_before on commit drop as select jsonb_agg(to_jsonb(c) order by c.id) stored from private.app_crashes c;
set local role service_role;
select public.crash_admin_read(cr_test.u(9001));
reset role;
select cr_test.assert_that((select jsonb_agg(to_jsonb(c) order by c.id) from private.app_crashes c) = (select stored from cr_before), 'reading changes nothing');

-- Retention: the daily privacy sweep removes reports received over 30 days ago, in bounded batches.
delete from private.app_crashes;
select cr_test.put(50, interval '31 days');
select cr_test.put(51, interval '32 days');
select cr_test.put(52, interval '29 days');
create temporary table cr_sweep on commit drop as select private.privacy_retention_sweep(1) r;
select cr_test.assert_that((select r->>'crash_reports' = '1' and (r->>'more')::boolean from cr_sweep), 'a bounded batch says there may be more');
select cr_test.assert_that(not exists (select 1 from private.app_crashes where id = cr_test.u(51)), 'the oldest goes first');
select cr_test.assert_that(private.privacy_retention_sweep(500)->>'crash_reports' = '1', 'the second batch');
-- A separate statement, so it sees the sweep's deletes.
select cr_test.assert_that(exists (select 1 from private.app_crashes where id = cr_test.u(52))
  and not exists (select 1 from private.app_crashes where id = cr_test.u(50)), 'reports over 30 days old are removed, newer ones stay');
select cr_test.assert_that(private.privacy_retention_sweep(500)->>'crash_reports' = '0', 'nothing left due');

-- The function reports Edge signals like the others.
set local role service_role;
select public.ops_signal_record('crash-reports', 'server_error', 1);
reset role;
select cr_test.assert_that(exists (select 1 from private.ops_signals where source = 'crash-reports'), 'crash-reports is a signal source');

rollback;
