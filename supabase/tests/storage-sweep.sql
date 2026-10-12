-- Rollback-only T51b fixtures: what the storage sweep may remove (decided evidence after 30 days, unreferenced
-- objects after 24 hours, only in the three app buckets), how confirmation records purges only once the object is
-- gone, what reviewers see afterwards and the monitor's storage.backlog check. Runs on PGlite (storage stub) and
-- Docker; removal stands in for the Storage API with a trusted delete. The served worker is storage-sweep-local.cjs.
begin;
do $$ begin
  if exists (select 1 from private.storage_sweep_candidates(clock_timestamp())) then
    raise exception 'Run storage-sweep.sql on a database with nothing due for the storage sweep';
  end if;
end $$;

create schema storage_test;
create function storage_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Storage sweep assertion failed: %', message; end if; end; $$;
create function storage_test.is(actual text, expected text, message text) returns void language plpgsql as $$
begin
  if actual is distinct from expected then raise exception 'Storage sweep assertion failed: % (expected "%", got "%")', message, expected, actual; end if;
end; $$;
create function storage_test.expect_error(statement text, code text, hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint = pg_exception_hint;
    if sqlstate = code and (hint is null or actual_hint = hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %', code, hint, sqlstate, actual_hint, sqlerrm;
  end;
  raise exception 'Expected failure: %', statement;
end; $$;
create function storage_test.u(n text) returns uuid language sql immutable as $$ select ('ce100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function storage_test.o(n text) returns text language sql immutable as $$ select 'ce400000-0000-4000-8000-0000000000'||n; $$;
create function storage_test.k(n text) returns uuid language sql immutable as $$ select ('ce500000-0000-4000-8000-0000000000'||n)::uuid; $$;
-- An object name under a user's (or the venue's) folder.
create function storage_test.p(folder uuid, n text) returns text language sql immutable as $$ select folder::text||'/'||storage_test.o(n)||'.jpg'; $$;
create function storage_test.venue() returns uuid language sql immutable as $$ select 'ce200000-0000-4000-8000-000000000001'::uuid; $$;
-- Due items as "bucket path-tail reason" (the path tail is "<folder digit>/<object number>"), in the order given.
create function storage_test.short(item jsonb) returns text language sql immutable as $$
  select (item->>'bucket')||' '||right(split_part(item->>'path', '/', 1), 1)||'/'||substr(split_part(item->>'path', '/', 2), 35, 2)||' '||(item->>'reason'); $$;
create function storage_test.due(n integer default 1000) returns text language sql as $$
  select coalesce(string_agg(storage_test.short(i), ', ' order by ord), '') from jsonb_array_elements(public.storage_sweep_due(n)->'items') with ordinality x(i, ord); $$;
create function storage_test.backlog() returns text language sql security definer set search_path = '' as $$
  select (c->>'status')||':'||(c->>'count') from jsonb_array_elements(private.ops_health(clock_timestamp())) c where c->>'check' = 'storage.backlog'; $$;
-- Storage API removal stands in for the worker (Docker's storage schema refuses plain deletes without this setting).
create function storage_test.remove(bucket text, names text[]) returns void language plpgsql security definer as $$
begin
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects where bucket_id = bucket and name = any(names);
  perform set_config('storage.allow_delete_query', 'false', true);
end; $$;
create function storage_test.confirm(items jsonb) returns text language sql as $$
  select (r->>'purged')||'/'||(r->>'remaining') from public.storage_sweep_confirm(items) r; $$;
grant usage on schema storage_test to anon, authenticated, service_role;
grant execute on all functions in schema storage_test to anon, authenticated, service_role;

-- Only the service role reaches the two commands; nobody reaches the private helpers.
select storage_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname in ('public','private') and p.proname like 'storage\_sweep%' and has_function_privilege(r.name, p.oid, 'execute')),
  'no client role executes storage sweep functions');
select storage_test.assert_that((select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','private') and p.proname like 'storage\_sweep%' and has_function_privilege('service_role', p.oid, 'execute'))
  = array['storage_sweep_confirm','storage_sweep_due'], 'service role executes exactly the two commands');
set local role authenticated;
select storage_test.expect_error('select public.storage_sweep_due(10)', '42501');
select storage_test.expect_error($$select public.storage_sweep_confirm('[]')$$, '42501');
reset role;
set local role service_role;
select storage_test.expect_error('select * from private.storage_sweep_candidates(clock_timestamp())', '42501');
select storage_test.expect_error('select private.storage_sweep_kick()', '42501');
select storage_test.expect_error('select private.storage_sweep_schedule()', '42501');
select storage_test.is(storage_test.due(), '', 'nothing due before the fixtures');
reset role;

-- Fixtures: claimants 1 and 5, submitter 2, reviewer 3 (admin), avatar owner 4; a folder 9 with no account.
insert into auth.users(id) select storage_test.u(n::text) from generate_series(1, 5) n;
insert into private.account_roles(user_id, role) values (storage_test.u('3'), 'admin');
insert into public.venues(id, name, address_line, city, province, latitude, longitude, publication_status, claim_status) values
  (storage_test.venue(), 'Sweep Fixture', 'Fixture', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'verified');
insert into storage.buckets(id, name, public) values ('sweep-test-other', 'sweep-test-other', false);
insert into storage.objects(bucket_id, name, created_at) values
  ('owner-evidence', storage_test.p(storage_test.u('1'), '01'), clock_timestamp() - interval '33 days'),  -- claim A, decided 32 days ago
  ('owner-evidence', storage_test.p(storage_test.u('5'), '02'), clock_timestamp() - interval '33 days'),  -- claim B, decided 29 days ago
  ('owner-evidence', storage_test.p(storage_test.u('1'), '03'), clock_timestamp() - interval '33 days'),  -- claim C, pending
  ('owner-evidence', storage_test.p(storage_test.u('2'), '05'), clock_timestamp() - interval '31 days'),  -- submission E, decided 30 days 2 hours ago
  ('owner-evidence', storage_test.p(storage_test.u('1'), '07'), clock_timestamp() - interval '25 hours'), -- an uncertain upload
  ('owner-evidence', storage_test.p(storage_test.u('1'), '08'), clock_timestamp() - interval '23 hours'), -- one still in its grace
  ('owner-evidence', storage_test.p(storage_test.u('5'), '10'), clock_timestamp() - interval '41 days'),  -- named only by purged claim G
  ('venue-photos', storage_test.p(storage_test.venue(), '11'), clock_timestamp() - interval '3 days'),     -- a listing photo
  ('venue-photos', storage_test.p(storage_test.venue(), '12'), clock_timestamp() - interval '50 hours'),   -- a removal whose cleanup failed
  ('venue-photos', storage_test.p(storage_test.venue(), '13'), clock_timestamp() - interval '1 hour'),
  ('venue-photos', storage_test.p(storage_test.venue(), '14'), null),                                       -- unknown age
  ('avatars', storage_test.p(storage_test.u('4'), '21'), clock_timestamp() - interval '3 days'),           -- the current avatar
  ('avatars', storage_test.p(storage_test.u('4'), '22'), clock_timestamp() - interval '30 hours'),         -- a replaced one
  ('avatars', storage_test.p(storage_test.u('4'), '23'), clock_timestamp() - interval '2 hours'),
  ('avatars', storage_test.p(storage_test.u('9'), '24'), clock_timestamp() - interval '3 days'),           -- an Auth user deleted outside the app
  ('sweep-test-other', storage_test.p(storage_test.u('1'), '31'), clock_timestamp() - interval '40 days');
insert into private.venue_claims(venue_id, claimant_user_id, evidence_path, request_id, status, reviewed_by, reviewed_at, review_reason, evidence_purged_at) values
  (storage_test.venue(), storage_test.u('1'), storage_test.p(storage_test.u('1'), '01'), storage_test.k('01'), 'approved', storage_test.u('3'), clock_timestamp() - interval '32 days', null, null),
  (storage_test.venue(), storage_test.u('5'), storage_test.p(storage_test.u('5'), '02'), storage_test.k('02'), 'rejected', storage_test.u('3'), clock_timestamp() - interval '29 days', 'not_owner', null),
  (storage_test.venue(), storage_test.u('1'), storage_test.p(storage_test.u('1'), '03'), storage_test.k('03'), 'pending', null, null, null, null),
  (storage_test.venue(), storage_test.u('5'), storage_test.p(storage_test.u('5'), '04'), storage_test.k('04'), 'approved', storage_test.u('3'), clock_timestamp() - interval '45 days', null, clock_timestamp() - interval '14 days'),
  (storage_test.venue(), storage_test.u('5'), storage_test.p(storage_test.u('5'), '10'), storage_test.k('10'), 'approved', storage_test.u('3'), clock_timestamp() - interval '40 days', null, clock_timestamp() - interval '9 days');
insert into private.venue_submissions(submitter_user_id, request_id, name, address_line, city, province, latitude, longitude, court_count,
    evidence_path, duplicates_acknowledged, status, reviewed_by, reviewed_at, review_reason) values
  (storage_test.u('2'), storage_test.k('05'), 'Sweep Proposed', 'Fixture', 'Manila', 'Metro Manila', 14.61, 121.01, 2,
    storage_test.p(storage_test.u('2'), '05'), false, 'rejected', storage_test.u('3'), clock_timestamp() - interval '30 days 2 hours', 'not_a_venue');
insert into public.venue_photos(venue_id, storage_path, width, height) values (storage_test.venue(), storage_test.p(storage_test.venue(), '11'), 800, 600);
update public.profiles set avatar_path = storage_test.p(storage_test.u('4'), '21') where id = storage_test.u('4');
create function storage_test.claim(n text) returns uuid language sql security definer set search_path = '' as $$
  select id from private.venue_claims where request_id = storage_test.k(n); $$;
create function storage_test.submission(n text) returns uuid language sql security definer set search_path = '' as $$
  select id from private.venue_submissions where request_id = storage_test.k(n); $$;
create function storage_test.purged() returns text language sql security definer set search_path = '' as $$
  select coalesce(string_agg(right(request_id::text, 2), ',' order by request_id), '') from (
    select request_id from private.venue_claims where evidence_purged_at is not null and request_id::text like 'ce500000-%'
    union all select request_id from private.venue_submissions where evidence_purged_at is not null and request_id::text like 'ce500000-%') x; $$;
grant execute on all functions in schema storage_test to anon, authenticated, service_role;

-- What is due: decided evidence after 30 days, then unreferenced objects after 24 hours, ordered; never a pending
-- claim's evidence, a newer decision, an object in its grace or of unknown age, a referenced photo or avatar, or
-- another bucket. An object named only by a claim that was already purged is unreferenced.
set local role service_role;
select storage_test.is(storage_test.due(),
  'owner-evidence 1/01 evidence_retention, owner-evidence 2/05 evidence_retention, avatars 4/22 unreferenced, avatars 9/24 unreferenced, '
  'owner-evidence 1/07 unreferenced, owner-evidence 5/10 unreferenced, venue-photos 1/12 unreferenced', 'due items, evidence first');
select storage_test.is(storage_test.due(2), 'owner-evidence 1/01 evidence_retention, owner-evidence 2/05 evidence_retention', 'a bounded batch');
select storage_test.assert_that((public.storage_sweep_due(2)->>'more')::boolean, 'more after a full batch');
select storage_test.assert_that(not (public.storage_sweep_due(7)->>'more')::boolean, 'no more after the last item');
select storage_test.assert_that(jsonb_array_length(public.storage_sweep_due(1)->'items') = 1, 'a batch of one');
select storage_test.expect_error('select public.storage_sweep_due(0)', '22023', 'invalid_input');
select storage_test.expect_error('select public.storage_sweep_due(1001)', '22023', 'invalid_input');
select storage_test.expect_error('select public.storage_sweep_due(null)', '22023', 'invalid_input');
reset role;

-- The monitor: items due over a day ago (claim A's evidence, the 50-hour photo, the deleted user's avatar and the
-- object only purged claim G names) are a backlog; ones due less than a day ago are not yet.
select storage_test.is(storage_test.backlog(), 'warn:4', 'four items over a day late');
do $$ begin
  if to_regclass('cron.job') is null then
    perform storage_test.is((select c->>'count' from jsonb_array_elements(private.ops_health(clock_timestamp())) c where c->>'check' = 'cron.jobs'), '5',
      'without pg_cron all five jobs, storage-sweep included, are missing');
  end if;
end $$;

-- Confirmation: before removal everything is still there and nothing is recorded.
create table storage_test.due_items(items jsonb);
grant all on storage_test.due_items to service_role;
set local role service_role;
insert into storage_test.due_items select public.storage_sweep_due(1000)->'items';
select storage_test.is(storage_test.confirm((select items from storage_test.due_items)), '0/7', 'nothing removed yet');
reset role;
-- Storage removed three of them; only claim A is recorded, the rest are retried next time.
select storage_test.remove('owner-evidence', array[storage_test.p(storage_test.u('1'), '01')]);
select storage_test.remove('avatars', array[storage_test.p(storage_test.u('4'), '22')]);
select storage_test.remove('venue-photos', array[storage_test.p(storage_test.venue(), '12')]);
set local role service_role;
select storage_test.is(storage_test.confirm((select items from storage_test.due_items)), '1/4', 'claim A purged, four still present');
select storage_test.is(storage_test.purged(), '01,04,10', 'claim A recorded beside the earlier purges');
select storage_test.is(storage_test.confirm((select items from storage_test.due_items)), '0/4', 'confirming again records nothing twice');
select storage_test.is(storage_test.due(),
  'owner-evidence 2/05 evidence_retention, avatars 9/24 unreferenced, owner-evidence 1/07 unreferenced, owner-evidence 5/10 unreferenced',
  'only what is left is due');
reset role;
select storage_test.remove('owner-evidence', array[storage_test.p(storage_test.u('2'), '05'), storage_test.p(storage_test.u('1'), '07'), storage_test.p(storage_test.u('5'), '10')]);
select storage_test.remove('avatars', array[storage_test.p(storage_test.u('9'), '24')]);
set local role service_role;
select storage_test.is(storage_test.confirm((select items from storage_test.due_items)), '1/0', 'submission E purged, nothing left');
select storage_test.is(storage_test.due(), '', 'nothing due');
reset role;
select storage_test.is(storage_test.purged(), '01,04,05,10', 'claim A and submission E purged');
select storage_test.is(storage_test.backlog(), 'ok:0', 'no backlog');
select storage_test.assert_that((select count(*) from storage.objects where name like '%/ce400000-%') = 9, 'every kept object is still there');

-- A purge is recorded only for decided evidence past its 30 days, whatever the caller sends: claim B (29 days) and
-- pending claim C lose their objects here, yet stay unpurged and are not due.
select storage_test.remove('owner-evidence', array[storage_test.p(storage_test.u('5'), '02'), storage_test.p(storage_test.u('1'), '03')]);
set local role service_role;
select storage_test.is(storage_test.confirm(jsonb_build_array(
  jsonb_build_object('bucket', 'owner-evidence', 'path', storage_test.p(storage_test.u('5'), '02'), 'reason', 'evidence_retention'),
  jsonb_build_object('bucket', 'owner-evidence', 'path', storage_test.p(storage_test.u('1'), '03'), 'reason', 'unreferenced'))), '0/0', 'not due: nothing recorded');
select storage_test.is(storage_test.purged(), '01,04,05,10', 'claims B and C unpurged');
select storage_test.is(storage_test.due(), '', 'and not due');
-- Input is checked strictly.
select storage_test.is(storage_test.confirm('[]'), '0/0', 'an empty batch');
select storage_test.expect_error($$select public.storage_sweep_confirm(null)$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('{}')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[1]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"sweep-test-other","path":"a/b.jpg","reason":"unreferenced"}]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"avatars","path":"a/b.jpg","reason":"old"}]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"avatars","path":"","reason":"unreferenced"}]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"avatars","path":7,"reason":"unreferenced"}]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"avatars","path":"a/b.jpg","reason":"unreferenced","extra":1}]')$$, '22023', 'invalid_input');
select storage_test.expect_error($$select public.storage_sweep_confirm('[{"bucket":"avatars","path":"a/b.jpg"}]')$$, '22023', 'invalid_input');
select storage_test.expect_error(format('select public.storage_sweep_confirm(%L)', jsonb_build_array(jsonb_build_object('bucket', 'avatars', 'path', repeat('a', 1025), 'reason', 'unreferenced'))), '22023', 'invalid_input');
select storage_test.expect_error(format('select public.storage_sweep_confirm(%L)', (select jsonb_agg(jsonb_build_object('bucket', 'avatars', 'path', 'a/b.jpg', 'reason', 'unreferenced')) from generate_series(1, 1001))), '22023', 'invalid_input');
reset role;

-- Reviewers: purged evidence reads as removed (not missing), the read carries the purge time, other evidence still streams.
select storage_test.expect_error(format('select public.ownership_review_evidence(%L, %L)', storage_test.u('3'), storage_test.claim('01')), 'P0002', 'evidence_removed');
select storage_test.expect_error(format('select public.ownership_review_evidence(%L, %L)', storage_test.u('3'), storage_test.submission('05')), 'P0002', 'evidence_removed');
select storage_test.is(public.ownership_review_evidence(storage_test.u('3'), storage_test.claim('03')), storage_test.p(storage_test.u('1'), '03'), 'an unpurged path is still returned');
select storage_test.expect_error(format('select public.ownership_review_evidence(%L, %L)', storage_test.u('1'), storage_test.claim('01')), '42501', 'reviewer_required');
select storage_test.expect_error(format('select public.ownership_review_evidence(%L, %L)', storage_test.u('3'), storage_test.k('99')), 'P0002', 'not_found');
select storage_test.assert_that((public.ownership_review_read(storage_test.u('3'), storage_test.claim('01'))->>'evidence_removed_at')::timestamptz
  > clock_timestamp() - interval '1 minute', 'claim A: removed just now');
select storage_test.assert_that((public.ownership_review_read(storage_test.u('3'), storage_test.submission('05'))->>'evidence_removed_at') is not null, 'submission E: removed');
select storage_test.assert_that(public.ownership_review_read(storage_test.u('3'), storage_test.claim('02'))->'evidence_removed_at' = 'null'::jsonb, 'claim B: kept');
select storage_test.assert_that(public.ownership_review_read(storage_test.u('3'), storage_test.claim('02'))->>'kind' = 'claim', 'the item itself is unchanged');
select storage_test.expect_error(format('select public.ownership_review_read(%L, %L)', storage_test.u('1'), storage_test.claim('01')), '42501', 'reviewer_required');

-- Only a decided item can be marked purged.
select storage_test.expect_error(format('update private.venue_claims set evidence_purged_at = clock_timestamp() where id = %L', storage_test.claim('03')), '23514');
select storage_test.expect_error(format('insert into private.venue_submissions(submitter_user_id, request_id, name, address_line, city, province, latitude, longitude, court_count,
  evidence_path, duplicates_acknowledged, venue_id, evidence_purged_at) values (%L, %L, %L, %L, %L, %L, 14.6, 121, 1, %L, false, %L, clock_timestamp())',
  storage_test.u('2'), storage_test.k('06'), 'Pending', 'Fixture', 'Manila', 'Metro Manila', storage_test.p(storage_test.u('2'), '06'), storage_test.venue()), '23514');

-- The monitor's signal source list now includes the worker; other names stay refused.
set local role service_role;
select public.ops_signal_record('storage-sweep', 'server_error', 1);
select storage_test.expect_error($$select public.ops_signal_record('storage-sweeper','server_error',1)$$, '22023', 'invalid_input');
reset role;
rollback;
