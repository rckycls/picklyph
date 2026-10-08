-- Synthetic role fixtures only; run on a disposable migrated local database.
begin;
create schema authorization_test;
create function authorization_test.assert_that(result boolean, message text) returns void
language plpgsql as $$
begin
  if result is distinct from true then raise exception 'Authorization assertion failed: %', message; end if;
end;
$$;
create function authorization_test.expect_error(statement text, expected_code text) returns void
language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise exception 'Expected %, got % for %', expected_code, sqlstate, statement;
  end;
  raise exception 'Expected % but statement succeeded: %', expected_code, statement;
end;
$$;
grant usage on schema authorization_test to anon, authenticated, service_role;

-- The embedded runner creates this user before migration to test backfill.
-- Standalone SQL execution also works: its own fixture is rolled back below.
insert into auth.users(id) values ('10000000-0000-4000-8000-000000000099') on conflict(id) do nothing;
select authorization_test.assert_that(
  exists(select 1 from public.profiles where id = '10000000-0000-4000-8000-000000000099'), 'existing-user fixture has a profile');
insert into auth.users(id, raw_user_meta_data) values
  ('10000000-0000-4000-8000-000000000001', '{}'),
  ('10000000-0000-4000-8000-000000000002', '{}'),
  ('10000000-0000-4000-8000-000000000003', '{"role":"admin","roles":["admin"],"owner":true,"full_name":{"invalid":"name"}}'),
  ('10000000-0000-4000-8000-000000000004', '{}'),
  ('10000000-0000-4000-8000-000000000005', '{}'),
  ('10000000-0000-4000-8000-000000000006', '{}');
select authorization_test.assert_that(
  (select count(*) = 6 from public.profiles where id between '10000000-0000-4000-8000-000000000001' and '10000000-0000-4000-8000-000000000006'), 'signup creates one profile per user');
select authorization_test.assert_that(
  (select display_name is null from public.profiles where id = '10000000-0000-4000-8000-000000000003')
  and (select count(*) = 0 from private.account_roles), 'malformed metadata cannot block signup or grant roles');

-- First administrator bootstrap is a trusted SQL operation, never a public RPC.
insert into private.account_roles(user_id, role) values ('10000000-0000-4000-8000-000000000001', 'admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('20000000-0000-4000-8000-000000000001', 'Owner fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'verified'),
  ('20000000-0000-4000-8000-000000000002', 'Other owner fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'verified'),
  ('20000000-0000-4000-8000-000000000003', 'Pending fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'pending'),
  ('20000000-0000-4000-8000-000000000004', 'Suspended fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'suspended', 'verified'),
  ('20000000-0000-4000-8000-000000000005', 'Draft fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'draft', 'verified'),
  ('20000000-0000-4000-8000-000000000006', 'Unclaimed fixture', 'Test', 'Manila', 'Metro Manila', 14.6, 121, 'approved', 'unclaimed');
insert into private.venue_claims(venue_id,claimant_user_id,evidence_path) values
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000004', 'authorization-test/not-a-real-file');

set local role service_role;
select public.set_account_role('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'moderator', true);
select public.set_account_role('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'moderator', true);
select authorization_test.assert_that((select count(*) = 1 from private.account_roles where role = 'moderator'), 'role assignment retries are idempotent');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000003','admin',true)$q$, '42501');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','admin',true)$q$, '42501');
select authorization_test.expect_error($q$select public.set_account_role(null,'10000000-0000-4000-8000-000000000003','admin',true)$q$, '42501');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000001',null,'admin',true)$q$, '22023');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000098','admin',true)$q$, '22023');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','admin',null)$q$, '22023');
select authorization_test.expect_error($q$insert into private.account_roles(user_id,role) values('10000000-0000-4000-8000-000000000003','admin')$q$, '42501');
select authorization_test.expect_error($q$delete from private.account_roles$q$, '42501');
select authorization_test.expect_error($q$insert into private.venue_owners(venue_id,user_id) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003')$q$, '42501');

-- T46 dropped T08's unaudited direct owner RPC: links come only from the audited T17
-- review or trusted operator SQL, so no admin/moderator call can link an owner directly.
select authorization_test.expect_error($q$select public.set_verified_venue_owner('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000005',true)$q$, '42883');
reset role;
insert into private.venue_owners(venue_id,user_id,verified_by) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000002'),
  ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001');
set local role service_role;
select authorization_test.assert_that((select count(*) = 4 from private.venue_owners), 'owners can have multiple verified venue links');
select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001');
select public.authorize_venue_management('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000005');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000002')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000003')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000004')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000005')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000098')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management(null,'20000000-0000-4000-8000-000000000001')$q$, '42501');
reset role;

-- Every client identity is authenticated in PostgreSQL, but application roles
-- never change its database role. Spoof/stale app_metadata is ignored as well.
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000003","role":"authenticated","user_metadata":{"role":"admin"},"app_metadata":{"role":"admin"}}', true);
set local role authenticated;
select authorization_test.assert_that((select count(*) = 1 from public.profiles), 'player reads only own profile');
select authorization_test.assert_that((select privileged_roles = '{}' and owned_venue_ids = '{}' from public.my_account_access()), 'JWT and signup metadata do not grant authorization');
update public.profiles set display_name = 'Player name';
select authorization_test.assert_that((select display_name = 'Player name' from public.profiles), 'own display name editable');
select authorization_test.expect_error($q$update public.profiles set display_name='   '$q$, '23514');
select authorization_test.expect_error($q$update public.profiles set created_at='2000-01-01'$q$, '42501');
select authorization_test.expect_error($q$update public.profiles set id='10000000-0000-4000-8000-000000000006'$q$, '42501');
select authorization_test.expect_error($q$insert into public.profiles(id) values('10000000-0000-4000-8000-000000000006')$q$, '42501');
select authorization_test.expect_error($q$delete from public.profiles$q$, '42501');
select authorization_test.expect_error($q$truncate public.profiles cascade$q$, '42501');
update public.profiles set display_name='Other name' where id='10000000-0000-4000-8000-000000000004';
select authorization_test.expect_error($q$select * from private.account_roles$q$, '42501');
select authorization_test.expect_error($q$select * from private.venue_owners$q$, '42501');
select authorization_test.expect_error($q$select * from private.venue_claims$q$, '42501');
select authorization_test.expect_error($q$select private.can_manage_venue('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001')$q$, '42501');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','admin',true)$q$, '42501');
select authorization_test.expect_error($q$select public.ownership_revoke('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','other')$q$, '42501');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001')$q$, '42501');
reset role;
select authorization_test.assert_that((select display_name is null from public.profiles where id='10000000-0000-4000-8000-000000000004'), 'editing another profile affects no rows');
select authorization_test.assert_that((select updated_at >= created_at from public.profiles where id='10000000-0000-4000-8000-000000000003'), 'profile timestamps maintained');

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select authorization_test.assert_that((select privileged_roles = '{}' and owned_venue_ids = array['20000000-0000-4000-8000-000000000001']::uuid[] from public.my_account_access()), 'owner access includes only own approved verified venue');
select authorization_test.assert_that((select count(*) = 4 from public.venues), 'ownership grants no draft/suspended directory read');
select authorization_test.expect_error($q$update public.venues set claim_status='verified'$q$, '42501');
select authorization_test.expect_error($q$update public.courts set status='inactive'$q$, '42501');
reset role;

select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select authorization_test.assert_that((select privileged_roles = array['admin']::public.privileged_role[] from public.my_account_access()), 'administrator sees current own assignment');
select authorization_test.expect_error($q$select public.set_account_role('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','admin',true)$q$, '42501');
select authorization_test.expect_error($q$select * from private.venue_claims$q$, '42501');
reset role;

-- Denied functions remain denied even if a future schema/table SELECT grant
-- slips through. RLS is a second barrier; default function EXECUTE is revoked.
grant usage on schema private to anon, authenticated;
grant select, insert, update, delete on private.account_roles, private.venue_owners, private.venue_claims to anon, authenticated;
select set_config('request.jwt.claims', '{}', true);
set local role anon;
select authorization_test.assert_that((select count(*) = 0 from private.account_roles), 'anon role RLS hides all assignments');
select authorization_test.assert_that((select count(*) = 0 from private.venue_owners), 'anon ownership RLS hides every owner');
select authorization_test.expect_error('select * from public.profiles', '42501');
select authorization_test.expect_error('select * from public.my_account_access()', '42501');
select authorization_test.expect_error($q$select private.has_account_role('10000000-0000-4000-8000-000000000001','admin')$q$, '42501');
reset role;
set local role authenticated;
select authorization_test.assert_that((select count(*) = 0 from public.profiles), 'missing identity exposes no profile');
select authorization_test.assert_that((select count(*) = 0 from private.account_roles), 'authenticated role RLS hides all assignments');
select authorization_test.assert_that((select count(*) = 0 from private.venue_owners), 'authenticated ownership RLS hides every owner');
select authorization_test.assert_that((select count(*) = 0 from private.venue_claims), 'claim evidence remains backend-only');
select authorization_test.expect_error('select * from public.my_account_access()', '42501');
select authorization_test.expect_error($q$select private.can_review_venues('10000000-0000-4000-8000-000000000001')$q$, '42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select authorization_test.assert_that((select count(*) = 0 from private.account_roles), 'even app-admin JWT cannot read protected role table');
select authorization_test.expect_error($q$insert into private.account_roles(user_id,role) values('10000000-0000-4000-8000-000000000003','admin')$q$, '42501');
select authorization_test.expect_error($q$insert into private.venue_owners(venue_id,user_id) values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003')$q$, '42501');
update private.account_roles set role='admin';
delete from private.account_roles;
delete from private.venue_owners;
reset role;
select authorization_test.assert_that((select count(*) = 2 from private.account_roles)
  and (select count(*) = 4 from private.venue_owners), 'accidental write grants still cannot mutate protected rows');
revoke select, insert, update, delete on private.account_roles, private.venue_owners, private.venue_claims from anon, authenticated;
revoke usage on schema private from anon, authenticated;

update public.venues set claim_status='pending' where id='20000000-0000-4000-8000-000000000001';
set local role service_role;
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001')$q$, '42501');
reset role;
update public.venues set claim_status='verified' where id='20000000-0000-4000-8000-000000000001';

-- Revocation takes effect on the next statement, even with an old token.
set local role service_role;
select public.set_account_role('10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','moderator',false);
select authorization_test.expect_error($q$select public.ownership_revoke('10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','other')$q$, '42501');
select public.ownership_revoke('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','other');
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001')$q$, '42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
set local role authenticated;
select authorization_test.assert_that((select owned_venue_ids = '{}' from public.my_account_access()), 'revoked ownership disappears without JWT refresh');
reset role;

-- A public verified badge alone grants nothing, and suspension immediately
-- gates previously linked owners without deleting their verified record.
update public.venues set publication_status='suspended' where id='20000000-0000-4000-8000-000000000002';
set local role service_role;
select authorization_test.expect_error($q$select public.authorize_venue_management('10000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000002')$q$, '42501');
reset role;
delete from auth.users where id='10000000-0000-4000-8000-000000000005';
select authorization_test.assert_that(not exists(select 1 from public.profiles where id='10000000-0000-4000-8000-000000000005')
  and not exists(select 1 from private.venue_owners where user_id='10000000-0000-4000-8000-000000000005'), 'account deletion cascades profile and ownership');
select set_config('request.jwt.claims', '{"sub":"10000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
set local role authenticated;
select authorization_test.expect_error('select * from public.my_account_access()', '42501');
reset role;
rollback;
