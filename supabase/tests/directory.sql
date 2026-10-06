-- Run only on a disposable migrated database. All synthetic fixtures roll back.
begin;

create schema directory_test;

create function directory_test.assert_that(result boolean, message text) returns void
language plpgsql as $$
begin
  if result is distinct from true then raise exception 'Directory assertion failed: %', message; end if;
end;
$$;
grant usage on schema directory_test to anon, authenticated, service_role;

insert into auth.users (id) values ('00000000-0000-4000-8000-000000000099');
insert into public.venues (id, name, address_line, city, province, latitude, longitude, publication_status, claim_status) values
  ('00000000-0000-4000-8000-000000000001', 'SQL fixture Manila', 'Test address', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'verified'),
  ('00000000-0000-4000-8000-000000000002', 'SQL fixture draft', 'Test address', 'Manila', 'Metro Manila', 14.6, 121, 'draft', 'pending'),
  ('00000000-0000-4000-8000-000000000003', 'SQL fixture suspended', 'Test address', 'Manila', 'Metro Manila', 14.6, 121, 'suspended', 'verified'),
  ('00000000-0000-4000-8000-000000000004', 'SQL fixture Cebu', 'Test address', 'Cebu City', 'Cebu', 10.3, 123.9, 'approved', 'unclaimed'),
  ('00000000-0000-4000-8000-000000000005', 'SQL fixture boundary', 'Test address', 'Test city', 'Test province', 15, 122, 'approved', 'unclaimed');
insert into public.courts (id, venue_id, name, status) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Active court', 'active'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'Inactive court', 'inactive'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000002', 'Draft venue court', 'active'),
  ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000003', 'Suspended venue court', 'active'),
  ('00000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000004', 'Cebu court', 'active');
insert into private.venue_claims (venue_id, claimant_user_id, evidence_path) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000099', 'private-test-evidence/not-a-real-file');

select directory_test.assert_that(
  (select extensions.st_x(location) = 121 and extensions.st_y(location) = 14.6 and extensions.st_srid(location) = 4326
   from public.venues where id = '00000000-0000-4000-8000-000000000001'),
  'generated geometry stores longitude first and latitude second in WGS84');
select directory_test.assert_that(
  exists(select 1 from pg_indexes where schemaname = 'public' and indexname = 'venues_location_gist'),
  'spatial index exists');
select directory_test.assert_that(
  not exists(select 1 from information_schema.columns where table_schema = 'public'
    and table_name in ('venues', 'courts') and column_name in ('claimant_user_id', 'evidence_path')),
  'public records have no claimant/evidence fields');

-- Both roles get the same safe directory. The assertions run with the caller's
-- privileges, not as the migration owner or a security-definer helper.
create function directory_test.check_client_access() returns void language plpgsql as $client$
declare statement text;
begin
  perform directory_test.assert_that((select count(*) = 3 from public.venues), 'only approved venues visible');
  perform directory_test.assert_that((select count(*) = 2 from public.courts), 'only active courts of approved venues visible');
  perform directory_test.assert_that((select count(*) = 2 from public.venues_in_bounds(14, 120, 15, 122)), 'spatial lookup filters private rows and includes boundary');
  perform directory_test.assert_that((select count(*) = 0 from public.venues_in_bounds(0, 0, 1, 1)), 'empty bounds return no listings');
  perform directory_test.assert_that((select count(*) = 1 from public.venues_in_bounds(10, 123, 11, 124)), 'Cebu remains discoverable nationwide');
  perform directory_test.assert_that((select count(*) = 0 from public.venues where publication_status <> 'approved'), 'draft/suspended rows stay hidden');
  begin
    perform 1 from private.venue_claims;
    raise exception 'claim evidence unexpectedly readable';
  exception when insufficient_privilege then null;
  end;
  foreach statement in array array[
    $$insert into public.venues(name,address_line,city,province,latitude,longitude) values('Unauthorized','X','X','X',14,121)$$,
    $$update public.venues set publication_status='approved'$$,
    $$update public.venues set claim_status='verified'$$,
    $$delete from public.venues$$,
    $$truncate public.venues cascade$$,
    $$insert into public.courts(venue_id,name) values('00000000-0000-4000-8000-000000000001','Unauthorized')$$,
    $$update public.courts set status='inactive'$$,
    $$delete from public.courts$$,
    $$insert into private.venue_claims(venue_id,claimant_user_id,evidence_path) values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000099','Unauthorized')$$
  ] loop
    begin
      execute statement;
      raise exception 'client mutation unexpectedly permitted: %', statement;
    exception when insufficient_privilege then null;
    end;
  end loop;
end;
$client$;

set local role anon;
select directory_test.check_client_access();
reset role;
set local role authenticated;
select directory_test.check_client_access();
reset role;

-- RLS is a second barrier if a future change accidentally grants table access.
grant usage on schema private to anon, authenticated;
grant select on private.venue_claims to anon, authenticated;
set local role anon;
select directory_test.assert_that((select count(*) = 0 from private.venue_claims), 'anon claim RLS denies every row');
reset role;
set local role authenticated;
select directory_test.assert_that((select count(*) = 0 from private.venue_claims), 'authenticated claim RLS denies every row');
reset role;
revoke all on private.venue_claims from anon, authenticated;
revoke all on schema private from anon, authenticated;

do $bounds$
declare statement text;
begin
  foreach statement in array array[
    'select * from public.venues_in_bounds(null,120,15,122)',
    'select * from public.venues_in_bounds(16,120,15,122)',
    'select * from public.venues_in_bounds(14,122,15,120)',
    'select * from public.venues_in_bounds(-91,120,15,122)',
    'select * from public.venues_in_bounds(14,120,15,181)',
    'select * from public.venues_in_bounds(''NaN'',120,15,122)',
    'select * from public.venues_in_bounds(14,120,''Infinity'',122)'
  ] loop
    begin
      execute statement;
      raise exception 'invalid bounds unexpectedly accepted: %', statement;
    exception when invalid_parameter_value then null;
    end;
  end loop;
end;
$bounds$;

do $constraints$
begin
  begin
    update public.venues set latitude = 'NaN' where id = '00000000-0000-4000-8000-000000000001';
    raise exception 'NaN coordinate accepted';
  exception when check_violation then null;
  end;
  begin
    update public.venues set country_code = 'US' where id = '00000000-0000-4000-8000-000000000001';
    raise exception 'non-PH country accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.courts(venue_id, name) values('00000000-0000-4000-8000-000000000098', 'Orphan');
    raise exception 'orphan court accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.courts(venue_id, name) values('00000000-0000-4000-8000-000000000001', 'Active court');
    raise exception 'duplicate court name accepted';
  exception when unique_violation then null;
  end;
end;
$constraints$;

-- Backend role can maintain listings/evidence; it never ships in the mobile client.
set local role service_role;
select directory_test.assert_that((select count(*) = 5 from public.venues), 'backend can access unpublished directory records');
select directory_test.assert_that((select count(*) = 1 from private.venue_claims), 'backend can access claim evidence');
update public.venues set longitude = 121.2, updated_at = '2000-01-01' where id = '00000000-0000-4000-8000-000000000001';
reset role;
select directory_test.assert_that(
  (select extensions.st_x(location) = 121.2 and updated_at > '2000-01-01' from public.venues
   where id = '00000000-0000-4000-8000-000000000001'), 'coordinate updates recompute geometry and timestamps');

insert into public.venues(name,address_line,city,province,latitude,longitude,publication_status)
  select 'Limit fixture ' || g, 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'approved' from generate_series(1, 220) g;
set local role anon;
select directory_test.assert_that((select count(*) = 200 from public.venues_in_bounds(14,120,15,122)), 'spatial results have a hard 200-row cap');
reset role;

rollback;
