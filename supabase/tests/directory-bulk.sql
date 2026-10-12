-- Rollback-only fixtures for the console bulk actions (2026-10-13): the status-filtered directory read and the
-- audited delete of unused listings. Runs on PGlite and Docker; the console route is covered by apps/admin tests.
begin;
create schema bulk_test;
create function bulk_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Directory bulk assertion failed: %', message; end if; end; $$;
create function bulk_test.expect_error(statement text, code text, hint text default null, detail text default null) returns void language plpgsql as $$
declare actual_hint text; actual_detail text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint = pg_exception_hint, actual_detail = pg_exception_detail;
    if sqlstate = code and (hint is null or actual_hint = hint) and (detail is null or actual_detail = detail) then return; end if;
    raise exception 'Expected %/%/%, got %/%/%: %', code, hint, detail, sqlstate, actual_hint, actual_detail, sqlerrm;
  end;
  raise exception 'Expected failure: %', statement;
end; $$;
create function bulk_test.u(n text) returns uuid language sql immutable as $$ select ('cf100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function bulk_test.v(n text) returns uuid language sql immutable as $$ select ('cf200000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function bulk_test.c(n text) returns uuid language sql immutable as $$ select ('cf300000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function bulk_test.version(n text) returns text language sql stable security definer set search_path = '' as $$
  select updated_at::text from public.venues where id = bulk_test.v(n); $$;
create function bulk_test.delete(n text, actor text default '1') returns text language sql as $$
  select public.directory_admin_delete(bulk_test.u(actor), bulk_test.v(n), bulk_test.version(n)::timestamptz)->>'outcome'; $$;
create function bulk_test.delete_error(n text, hint text, detail text default null) returns void language sql as $$
  select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, %L)', bulk_test.u('1'), bulk_test.v(n), bulk_test.version(n)), '55006', hint, detail); $$;
-- The test venues a filtered read returns, as a sorted list of their numbers (other venues in the database are ignored).
create function bulk_test.listed(filter public.venue_publication_status) returns text language sql as $$
  select coalesce(string_agg(right(i->>'id', 2), ',' order by i->>'id'), '')
  from jsonb_array_elements(public.directory_admin_read(bulk_test.u('1'), null, null, filter)->'items') i where i->>'id' like 'cf200000-%'; $$;
create function bulk_test.exists(n text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.venues where id = bulk_test.v(n)); $$;
grant usage on schema bulk_test to anon, authenticated, service_role;
grant execute on all functions in schema bulk_test to anon, authenticated, service_role;

-- Only the service role runs the commands; nobody runs the private blocker check.
select bulk_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname in ('public','private') and p.proname in ('directory_admin_read','directory_admin_delete','directory_delete_blocker')
    and has_function_privilege(r.name, p.oid, 'execute')), 'no client role runs directory commands');
select bulk_test.assert_that(has_function_privilege('service_role', 'public.directory_admin_delete(uuid,uuid,timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.directory_admin_read(uuid,uuid,uuid,public.venue_publication_status)', 'execute')
  and not has_function_privilege('service_role', 'private.directory_delete_blocker(uuid)', 'execute'), 'service role grants');
select bulk_test.assert_that(not exists(select 1 from pg_proc where proname = 'directory_admin_read' and pronargs = 3), 'the three-argument read was replaced');

-- Fixtures: an admin (1), a moderator (2), a player (3). Venues 01–03: unused draft, suspended and published;
-- 04–11 drafts with one kind of history each; 12 a draft for a stale version.
insert into auth.users(id) select bulk_test.u(n::text) from generate_series(1, 3) n;
insert into private.account_roles(user_id, role) values (bulk_test.u('1'), 'admin'), (bulk_test.u('2'), 'moderator');
insert into public.venues(id, name, address_line, city, province, latitude, longitude, publication_status)
  select bulk_test.v(lpad(n::text, 2, '0')), 'Bulk Fixture '||n, 'Fixture', 'Manila', 'Metro Manila', 14.6, 121,
    case n when 2 then 'suspended' when 3 then 'approved' else 'draft' end::public.venue_publication_status
  from generate_series(1, 12) n;
insert into public.courts(id, venue_id, name, status) select bulk_test.c(lpad(n::text, 2, '0')), bulk_test.v(lpad(n::text, 2, '0')), 'Court 1', 'active'
  from generate_series(1, 12) n;
-- Configuration goes with an unused listing: a policy, an import reference.
insert into private.venue_policies(venue_id, confirmation, payment) values (bulk_test.v('01'), 'instant', 'arrival');
insert into private.directory_import_refs(reference, venue_id, original_input) values ('bulk-test:01', bulk_test.v('01'), '{}');
-- History: a released court block (04), an owner (05), a claim (06), an owner's submission resolved into it (07),
-- a photo (08), a report (09), a merchant row (10), a cancelled session (11).
insert into private.court_allocations(venue_id, court_id, kind, starts_at, ends_at, state, ended_at, requested_by, request_id)
  values (bulk_test.v('04'), bulk_test.c('04'), 'block', date_trunc('hour', now()) - interval '3 days', date_trunc('hour', now()) - interval '3 days' + interval '1 hour',
    'released', now() - interval '3 days', bulk_test.u('1'), gen_random_uuid());
insert into private.venue_owners(user_id, venue_id) values (bulk_test.u('3'), bulk_test.v('05'));
insert into private.venue_claims(venue_id, claimant_user_id, evidence_path, request_id, status, reviewed_by, reviewed_at, review_reason)
  values (bulk_test.v('06'), bulk_test.u('3'), bulk_test.u('3')||'/cf400000-0000-4000-8000-000000000006.jpg', gen_random_uuid(), 'rejected', bulk_test.u('2'), now(), 'not_owner');
insert into private.venue_submissions(submitter_user_id, request_id, name, address_line, city, province, latitude, longitude, court_count,
    evidence_path, duplicates_acknowledged, status, reviewed_by, reviewed_at, review_reason, resolution, resolved_venue_id)
  values (bulk_test.u('3'), gen_random_uuid(), 'Bulk Proposed', 'Fixture', 'Manila', 'Metro Manila', 14.6, 121, 1,
    bulk_test.u('3')||'/cf400000-0000-4000-8000-000000000007.jpg', false, 'approved', bulk_test.u('1'), now(), null, 'merge', bulk_test.v('07'));
insert into public.venue_photos(venue_id, storage_path, width, height)
  values (bulk_test.v('08'), bulk_test.v('08')||'/cf400000-0000-4000-8000-000000000008.jpg', 800, 600);
insert into private.venue_reports(venue_id, reporter_user_id, request_id, reason, status, reviewed_by, reviewed_at)
  values (bulk_test.v('09'), bulk_test.u('3'), gen_random_uuid(), 'closed', 'dismissed', bulk_test.u('2'), now());
insert into private.venue_merchants(venue_id, active) values (bulk_test.v('10'), false);
insert into private.open_play_sessions(venue_id, created_by, request_id, request_input, snapshot, starts_at, ends_at, capacity, status, cancelled_at)
  values (bulk_test.v('11'), bulk_test.u('1'), gen_random_uuid(), '{}', '{}', date_trunc('hour', now()) - interval '3 days',
    date_trunc('hour', now()) - interval '3 days' + interval '2 hours', 8, 'cancelled', now() - interval '4 days');

-- Filtered reads: each status alone, and everything without a filter (also callable the old way, three arguments).
set local role service_role;
select bulk_test.assert_that(bulk_test.listed('draft') = '01,04,05,06,07,08,09,10,11,12', 'drafts only: '||bulk_test.listed('draft'));
select bulk_test.assert_that(bulk_test.listed('suspended') = '02', 'suspended only');
select bulk_test.assert_that(bulk_test.listed('approved') = '03', 'published only');
select bulk_test.assert_that(bulk_test.listed(null) = '01,02,03,04,05,06,07,08,09,10,11,12', 'no filter: all');
select bulk_test.assert_that((select count(*) from jsonb_array_elements(public.directory_admin_read(bulk_test.u('1'), null, null)->'items') i
  where i->>'id' like 'cf200000-%') = 12, 'the three-argument call still reads everything');
select bulk_test.expect_error(format('select public.directory_admin_read(%L, null, null, %L)', bulk_test.u('2'), 'draft'), '42501');

-- Delete: administrators only, current version only, never a published listing, never one with history.
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, %L)', bulk_test.u('2'), bulk_test.v('01'), bulk_test.version('01')), '42501');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, %L)', bulk_test.u('3'), bulk_test.v('01'), bulk_test.version('01')), '42501');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, null)', bulk_test.u('1'), bulk_test.v('01')), '22023');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, null, now())', bulk_test.u('1')), '22023');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, %L)', bulk_test.u('1'), bulk_test.v('12'), '2001-01-01T00:00:00Z'), '40001');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, now())', bulk_test.u('1'), bulk_test.v('99')), 'P0002');
select bulk_test.delete_error('03', 'listing_published');
select bulk_test.delete_error('04', 'listing_in_use', 'court_history');
select bulk_test.delete_error('05', 'listing_in_use', 'owner');
select bulk_test.delete_error('06', 'listing_in_use', 'claim');
select bulk_test.delete_error('07', 'listing_in_use', 'submission');
select bulk_test.delete_error('08', 'listing_in_use', 'photos');
select bulk_test.delete_error('10', 'listing_in_use', 'merchant');
select bulk_test.delete_error('11', 'listing_in_use', 'session_history');
select bulk_test.delete_error('09', 'listing_in_use', 'reports');
reset role;
select bulk_test.assert_that((select count(*) from public.venues where id::text like 'cf200000-%') = 12, 'nothing was deleted by refusals');
select bulk_test.assert_that(not exists (select 1 from private.directory_audit_events where action = 'directory.delete' and target_venue_id::text like 'cf200000-%'),
  'refusals write no audit row');

-- An unused draft and an unused suspended listing are deleted with their courts and configuration, audited once.
set local role service_role;
select bulk_test.assert_that(bulk_test.delete('01') = 'deleted', 'unused draft deleted');
select bulk_test.assert_that(bulk_test.delete('02') = 'deleted', 'unused suspended listing deleted');
select bulk_test.assert_that(bulk_test.listed(null) = '03,04,05,06,07,08,09,10,11,12', 'gone from the directory');
select bulk_test.expect_error(format('select public.directory_admin_delete(%L, %L, now())', bulk_test.u('1'), bulk_test.v('01')), 'P0002');
reset role;
select bulk_test.assert_that(not bulk_test.exists('01') and not bulk_test.exists('02'), 'venue rows removed');
select bulk_test.assert_that(not exists (select 1 from public.courts where venue_id in (bulk_test.v('01'), bulk_test.v('02')))
  and not exists (select 1 from private.venue_policies where venue_id = bulk_test.v('01'))
  and not exists (select 1 from private.directory_import_refs where venue_id = bulk_test.v('01')), 'courts, policy and import reference removed');
select bulk_test.assert_that((select string_agg(right(target_venue_id::text, 2)||':'||action||':'||right(actor_user_id::text, 1), ',' order by id)
  from private.directory_audit_events where target_venue_id::text like 'cf200000-%') = '01:directory.delete:1,02:directory.delete:1',
  'one attributed audit row per deletion, kept after the listing');
select bulk_test.assert_that(bulk_test.exists('12'), 'a refused stale delete kept its listing');
rollback;
