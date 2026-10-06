-- Synthetic fixtures, rollback only. Never run acceptance suites on hosted data.
begin;
create schema curation_test;
create function curation_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Curation assertion: %', message; end if; end;
$$;
create function curation_test.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise exception 'Expected %, got %: %', expected_code, sqlstate, sqlerrm;
  end;
  raise exception 'Expected % but command succeeded', expected_code;
end;
$$;
grant usage on schema curation_test to anon, authenticated, service_role;
create temp table curation_fixture(label text primary key, data jsonb);
grant select, insert, update on curation_fixture to service_role, anon, authenticated;
insert into auth.users(id) values
  ('31000000-0000-4000-8000-000000000001'),('31000000-0000-4000-8000-000000000002'),('31000000-0000-4000-8000-000000000003');
insert into private.account_roles(user_id,role) values
  ('31000000-0000-4000-8000-000000000001','admin'),('31000000-0000-4000-8000-000000000002','moderator');
insert into curation_fixture values
  ('venue','{"name":"Synthetic venue","address_line":"Test only","city":"Manila","province":"Metro Manila","latitude":14.6,"longitude":121}'),
  ('courts','[{"id":null,"name":"Court 1","surface":"hard","is_indoor":false,"is_covered":true,"status":"active"}]');
set local role service_role;
select curation_test.expect_error($q$select public.directory_admin_read(null)$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_read('31000000-0000-4000-8000-000000000002')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000003',null,null,'{}','[]')$q$,'42501');
insert into curation_fixture select 'saved', public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data from curation_fixture where label='venue'),(select data from curation_fixture where label='courts'));
select curation_test.assert_that((select data ->> 'publication_status'='draft' and data ->> 'claim_status'='unclaimed'
  and jsonb_array_length(data -> 'courts')=1 and not data ? 'location' from curation_fixture where label='saved'),'creation is draft/unclaimed with court');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"latitude":91}' from curation_fixture where label='venue'),'[]')$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"longitude":"121"}' from curation_fixture where label='venue'),'[]')$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"claim_status":"verified"}' from curation_fixture where label='venue'),'[]')$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"name":" "}' from curation_fixture where label='venue'),'[]')$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data from curation_fixture where label='venue'), '[{"id":null,"name":"A","surface":null,"is_indoor":"false","is_covered":false,"status":"active"}]')$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,
  (select data from curation_fixture where label='venue'), (select data || data from curation_fixture where label='courts'))$q$,'22023');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',
  (select (data ->> 'id')::uuid from curation_fixture where label='saved'), '2000-01-01T00:00:00Z',
  (select data from curation_fixture where label='venue'),'[]')$q$,'40001');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',
  (select (data ->> 'id')::uuid from curation_fixture where label='saved'), (select (data ->> 'updated_at')::timestamptz from curation_fixture where label='saved'),
  (select data from curation_fixture where label='venue'), '[{"id":"ffffffff-0000-4000-8000-000000000001","name":"Intruder","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]')$q$,'22023');
set local role anon;
select curation_test.assert_that((select count(*)=0 from public.venues),'draft is private');
select curation_test.assert_that((select count(*)=0 from public.courts),'draft court is private');
select curation_test.expect_error($q$select public.directory_admin_read('31000000-0000-4000-8000-000000000001')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,'{}','[]')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001','[]')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_publish('31000000-0000-4000-8000-000000000001',null,now(),'approved')$q$,'42501');
select curation_test.expect_error($q$select * from private.directory_import_refs$q$,'42501');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"31000000-0000-4000-8000-000000000001","role":"admin"}',true);
select curation_test.expect_error($q$select public.directory_admin_read('31000000-0000-4000-8000-000000000001')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',null,null,'{}','[]')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001','[]')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_publish('31000000-0000-4000-8000-000000000001',null,now(),'approved')$q$,'42501');
select curation_test.expect_error($q$update public.venues set publication_status='approved'$q$,'42501');
set local role service_role;
update curation_fixture set data=public.directory_admin_publish('31000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,'approved') where label='saved';
set local role anon;
select curation_test.assert_that((select count(*)=1 from public.venues),'publication exposes venue');
select curation_test.assert_that((select count(*)=1 from public.courts),'publication exposes active court');
select curation_test.assert_that((select claim_status='unclaimed' from public.venues),'publication cannot approve claim');
reset role;
insert into private.venue_claims(venue_id,claimant_user_id,evidence_path)
  select (data ->> 'id')::uuid,'31000000-0000-4000-8000-000000000003','curation-test/private-evidence' from curation_fixture where label='saved';
insert into private.venue_owners(venue_id,user_id)
  select (data ->> 'id')::uuid,'31000000-0000-4000-8000-000000000003' from curation_fixture where label='saved';
update public.venues set claim_status='pending';
set local role service_role;
update curation_fixture set data=public.directory_admin_save('31000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,(select data || '{"name":"Edited"}' from curation_fixture where label='venue'),
  jsonb_build_array((data -> 'courts' -> 0) - 'venue_id' - 'created_at' - 'updated_at' || '{"name":"Renamed"}')) where label='saved';
select curation_test.assert_that((select data ->> 'name'='Edited' and data ->> 'claim_status'='pending' from curation_fixture where label='saved'),'edit preserves claim state');
select curation_test.expect_error($q$select public.directory_admin_save('31000000-0000-4000-8000-000000000001',
  (select (data ->> 'id')::uuid from curation_fixture where label='saved'),(select (data ->> 'updated_at')::timestamptz from curation_fixture where label='saved'),
  (select data from curation_fixture where label='venue'),jsonb_build_array((select (data -> 'courts' -> 0) - 'venue_id' - 'created_at' - 'updated_at' || '{"status":"inactive"}' from curation_fixture where label='saved')))$q$,'22023');
update curation_fixture set data=public.directory_admin_publish('31000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,'suspended') where label='saved';
set local role anon;
select curation_test.assert_that((select count(*)=0 from public.venues),'suspension hides venue');
select curation_test.assert_that((select count(*)=0 from public.courts),'suspension hides courts');
reset role;
select curation_test.assert_that((select count(*)=1 from private.venue_claims) and (select count(*)=1 from private.venue_owners),'edits preserve evidence and owner link');
select curation_test.assert_that((select count(*)=1 from public.courts),'court identity preserved');
set local role service_role;
insert into curation_fixture select 'import', jsonb_build_array(jsonb_build_object('reference','curation-test:001',
  'venue',(select data from curation_fixture where label='venue'),'courts',(select data from curation_fixture where label='courts')));
insert into curation_fixture select 'import_result', public.directory_admin_import('31000000-0000-4000-8000-000000000001',data) from curation_fixture where label='import';
select curation_test.assert_that((select public.directory_admin_import('31000000-0000-4000-8000-000000000001',data) -> 0 ->> 'outcome'='existing' from curation_fixture where label='import'),'exact retry is a no-op');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001',
  (select jsonb_set(data,'{0,venue,name}','"Different"') from curation_fixture where label='import'))$q$,'23505');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001',
  (select jsonb_set(data,'{0,reference}','"curation-test:000"') || jsonb_set(data,'{0,venue,name}','"Different"') from curation_fixture where label='import'))$q$,'23505');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001',
  (select data || data from curation_fixture where label='import'))$q$,'22023');
reset role;
select curation_test.assert_that((select count(*)=2 from public.venues) and (select count(*)=1 from private.directory_import_refs),'conflicting batch rolls back newly created preceding row');
select curation_test.assert_that((select publication_status='draft' and claim_status='unclaimed' from public.venues where id=(select (data -> 0 ->> 'id')::uuid from curation_fixture where label='import_result')),'import stays draft/unclaimed');
insert into public.venues(name,address_line,city,province,latitude,longitude)
  select 'Pagination fixture ' || i,'Test','Manila','Metro Manila',14.6,121 from generate_series(1,101) i;
set local role service_role;
insert into curation_fixture select 'page',public.directory_admin_read('31000000-0000-4000-8000-000000000001');
select curation_test.assert_that((select jsonb_array_length(data -> 'items')=100 and data ->> 'next_cursor' is not null from curation_fixture where label='page'),'bounded first page');
select curation_test.assert_that((select jsonb_array_length(public.directory_admin_read('31000000-0000-4000-8000-000000000001',null,(data ->> 'next_cursor')::uuid) -> 'items')=3 from curation_fixture where label='page'),'cursor returns remainder');
reset role;
delete from private.account_roles where user_id='31000000-0000-4000-8000-000000000001';
set local role service_role;
select curation_test.expect_error($q$select public.directory_admin_read('31000000-0000-4000-8000-000000000001')$q$,'42501');
select curation_test.expect_error($q$select public.directory_admin_import('31000000-0000-4000-8000-000000000001','[]')$q$,'42501');
reset role;
rollback;
