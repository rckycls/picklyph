-- Synthetic local fixtures only; all data/schema changes roll back.
begin;
create schema audit_test;
create function audit_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Audit assertion: %', message; end if; end;
$$;
create function audit_test.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise exception 'Expected %, got %: %', expected_code, sqlstate, sqlerrm;
  end;
  raise exception 'Expected % but command succeeded', expected_code;
end;
$$;
grant usage on schema audit_test to anon, authenticated, service_role;
create temp table audit_fixture(label text primary key, data jsonb);
grant select, insert, update on audit_fixture to service_role, anon, authenticated;
insert into auth.users(id) values
  ('32000000-0000-4000-8000-000000000001'),('32000000-0000-4000-8000-000000000002'),
  ('32000000-0000-4000-8000-000000000003'),('32000000-0000-4000-8000-000000000004');
insert into private.account_roles(user_id,role) values
  ('32000000-0000-4000-8000-000000000001','admin'),('32000000-0000-4000-8000-000000000002','moderator'),
  ('32000000-0000-4000-8000-000000000004','admin');
insert into audit_fixture values
  ('venue','{"name":"Audit synthetic venue","address_line":"Do not log this address","city":"Manila","province":"Metro Manila","latitude":14.6,"longitude":121}'),
  ('courts','[{"id":null,"name":"Court 1","surface":"hard","is_indoor":false,"is_covered":true,"status":"active"}]');
set local role service_role;
select audit_test.expect_error($q$select public.directory_admin_audit_read(null)$q$,'42501');
select audit_test.expect_error($q$select public.directory_admin_audit_read('32000000-0000-4000-8000-000000000002')$q$,'42501');
select audit_test.expect_error($q$select public.directory_admin_audit_read('32000000-0000-4000-8000-000000000003')$q$,'42501');
select audit_test.expect_error($q$select public.directory_admin_audit_read('32000000-0000-4000-8000-000000000001',null,-1)$q$,'22023');
insert into audit_fixture select 'saved',public.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,
  (select data from audit_fixture where label='venue'),(select data from audit_fixture where label='courts'));
select audit_test.assert_that((select jsonb_array_length(public.directory_admin_audit_read('32000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid) -> 'items')=1 from audit_fixture where label='saved'),'create produces one event');
update audit_fixture set data=public.directory_admin_save('32000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,(select data || '{"name":"Edited"}' from audit_fixture where label='venue'),'[]') where label='saved';
update audit_fixture set data=public.directory_admin_publish('32000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,'approved') where label='saved';
update audit_fixture set data=public.directory_admin_publish('32000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,'draft') where label='saved';
update audit_fixture set data=public.directory_admin_publish('32000000-0000-4000-8000-000000000001',
  (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,'suspended') where label='saved';
insert into audit_fixture select 'page',public.directory_admin_audit_read('32000000-0000-4000-8000-000000000001',(data ->> 'id')::uuid) from audit_fixture where label='saved';
select audit_test.assert_that((select jsonb_path_query_array(data,'$.items[*].action')=
  '["directory.create","directory.update","directory.publish","directory.unpublish","directory.suspend"]'::jsonb
  and data ->> 'next_cursor' is null from audit_fixture where label='page'),'all actions and target filter');
reset role;
select audit_test.assert_that((select count(*)=5 and bool_and(actor_user_id='32000000-0000-4000-8000-000000000001'
  and occurred_at between transaction_timestamp() and clock_timestamp()) from private.directory_audit_events
  where target_venue_id=(select (data ->> 'id')::uuid from audit_fixture where label='saved')),'real actor/target and database time');
select audit_test.assert_that((select bool_and((select count(*)=5 from jsonb_object_keys(e)) and jsonb_typeof(e -> 'id')='string')
  from audit_fixture f, jsonb_array_elements(f.data -> 'items') e where label='page'),'minimal projection and lossless IDs');

-- Even the infrastructure role cannot write/read the table or bypass auditing.
do $$ declare client_role text; begin
  foreach client_role in array array['anon','authenticated','service_role'] loop
    execute format('set local role %I',client_role);
    perform audit_test.expect_error('select * from private.directory_audit_events','42501');
    perform audit_test.expect_error($q$insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
      values ('32000000-0000-4000-8000-000000000001','32000000-0000-4000-8000-000000000001','directory.create')$q$,'42501');
    perform audit_test.expect_error('update private.directory_audit_events set action=''directory.import''','42501');
    perform audit_test.expect_error('delete from private.directory_audit_events','42501');
    perform audit_test.expect_error('truncate private.directory_audit_events','42501');
    perform audit_test.expect_error('select nextval(''private.directory_audit_events_id_seq'')','42501');
    perform audit_test.expect_error($q$select private.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,'{}','[]')$q$,'42501');
    perform audit_test.expect_error($q$select private.directory_admin_publish('32000000-0000-4000-8000-000000000001',null,now(),'approved')$q$,'42501');
    if client_role <> 'service_role' then
      -- Claiming the true administrator UUID or JWT role does not grant RPC access.
      perform set_config('request.jwt.claims','{"sub":"32000000-0000-4000-8000-000000000001","role":"admin"}',true);
      perform audit_test.expect_error($q$select public.directory_admin_audit_read('32000000-0000-4000-8000-000000000001')$q$,'42501');
    end if;
    reset role;
  end loop;
end; $$;

set local role service_role;
select audit_test.expect_error($q$select public.directory_admin_save('32000000-0000-4000-8000-000000000003',null,null,
  (select data from audit_fixture where label='venue'),'[]')$q$,'42501');
select audit_test.expect_error($q$select public.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"actor_user_id":"32000000-0000-4000-8000-000000000004"}' from audit_fixture where label='venue'),'[]')$q$,'22023');
select audit_test.expect_error($q$select public.directory_admin_publish('32000000-0000-4000-8000-000000000001',
  (select (data ->> 'id')::uuid from audit_fixture where label='saved'),'2000-01-01','approved')$q$,'40001');
-- Fails after updating the venue, while inserting a colliding court name.
select audit_test.expect_error($q$select public.directory_admin_save('32000000-0000-4000-8000-000000000001',
  (select (data ->> 'id')::uuid from audit_fixture where label='saved'),(select (data ->> 'updated_at')::timestamptz from audit_fixture where label='saved'),
  (select data from audit_fixture where label='venue'),(select data from audit_fixture where label='courts'))$q$,'23505');
insert into audit_fixture select 'import',jsonb_build_array(jsonb_build_object('reference','audit-test:001',
  'venue',(select data from audit_fixture where label='venue'),'courts',jsonb_build_array()));
insert into audit_fixture select 'import_result',public.directory_admin_import('32000000-0000-4000-8000-000000000001',data) from audit_fixture where label='import';
select audit_test.assert_that((select public.directory_admin_import('32000000-0000-4000-8000-000000000001',data) -> 0 ->> 'outcome'='existing'
  from audit_fixture where label='import'),'import retry stays no-op');
-- Earlier entry writes both venue and audit; later reference conflict rolls both back.
select audit_test.expect_error($q$select public.directory_admin_import('32000000-0000-4000-8000-000000000001',
  (select jsonb_set(data,'{0,reference}','"audit-test:000"') || jsonb_set(data,'{0,venue,name}','"Conflict"') from audit_fixture where label='import'))$q$,'23505');
reset role;
select audit_test.assert_that((select count(*)=6 from private.directory_audit_events where actor_user_id='32000000-0000-4000-8000-000000000001'),
  'failed commands/batch and import retry add no successful audit');
select audit_test.assert_that((select count(*)=1 and bool_and(action='directory.import') from private.directory_audit_events
  where target_venue_id=(select (data -> 0 ->> 'id')::uuid from audit_fixture where label='import_result')),'one import event per created venue');
select audit_test.assert_that((select name='Edited' from public.venues where id=(select (data ->> 'id')::uuid from audit_fixture where label='saved')),
  'failed save restores previous venue');
select audit_test.assert_that(not exists(select 1 from private.directory_import_refs where reference='audit-test:000'),'failed batch leaves no earlier reference');

savepoint caller_rollback;
set local role service_role;
select public.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,(select data from audit_fixture where label='venue'),'[]');
rollback to savepoint caller_rollback;
select audit_test.assert_that((select count(*)=6 from private.directory_audit_events where actor_user_id='32000000-0000-4000-8000-000000000001'),
  'successful nested command disappears when enclosing transaction rolls back');

-- Audit persistence is mandatory: an audit insert error aborts the venue write.
create function audit_test.fail_insert() returns trigger language plpgsql as $$
begin raise exception 'Simulated audit storage failure' using errcode='23514'; end; $$;
create trigger audit_test_failure before insert on private.directory_audit_events for each row execute function audit_test.fail_insert();
set local role service_role;
select audit_test.expect_error($q$select public.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,
  (select data || '{"name":"Must roll back"}' from audit_fixture where label='venue'),'[]')$q$,'23514');
reset role;
select audit_test.assert_that(not exists(select 1 from public.venues where name='Must roll back'),'audit failure rolls back mutation');
drop trigger audit_test_failure on private.directory_audit_events;

-- Exercise bounded pages using real commands, not fabricated audit rows.
set local role service_role;
insert into audit_fixture select 'pagination',public.directory_admin_save('32000000-0000-4000-8000-000000000004',null,null,
  (select data from audit_fixture where label='venue'),'[]');
do $$ begin for i in 1..100 loop
  update audit_fixture set data=public.directory_admin_save('32000000-0000-4000-8000-000000000004',
    (data ->> 'id')::uuid,(data ->> 'updated_at')::timestamptz,
    (select data || jsonb_build_object('name','Audit pagination ' || i) from audit_fixture where label='venue'),'[]') where label='pagination';
end loop; end; $$;
insert into audit_fixture select 'bounded',public.directory_admin_audit_read('32000000-0000-4000-8000-000000000004',
  (data ->> 'id')::uuid) from audit_fixture where label='pagination';
select audit_test.assert_that((select jsonb_array_length(data -> 'items')=100 and jsonb_typeof(data -> 'next_cursor')='string'
  from audit_fixture where label='bounded'),'first audit page is bounded and cursor lossless');
select audit_test.assert_that((select jsonb_array_length(public.directory_admin_audit_read('32000000-0000-4000-8000-000000000004',
  (select (data ->> 'id')::uuid from audit_fixture where label='pagination'),(data ->> 'next_cursor')::bigint) -> 'items')=1
  from audit_fixture where label='bounded'),'next audit page has remainder without duplication');
select audit_test.assert_that(public.directory_admin_audit_read('32000000-0000-4000-8000-000000000004','ffffffff-0000-4000-8000-000000000001')=
  '{"items":[],"next_cursor":null}'::jsonb,'unknown venue yields empty safe projection');
reset role;
delete from private.account_roles where user_id='32000000-0000-4000-8000-000000000001';
set local role service_role;
select audit_test.expect_error($q$select public.directory_admin_audit_read('32000000-0000-4000-8000-000000000001')$q$,'42501');
select audit_test.expect_error($q$select public.directory_admin_save('32000000-0000-4000-8000-000000000001',null,null,'{}','[]')$q$,'42501');
reset role;
delete from public.venues where id=(select (data ->> 'id')::uuid from audit_fixture where label='saved');
delete from auth.users where id='32000000-0000-4000-8000-000000000001';
set local role service_role;
select audit_test.assert_that((select jsonb_array_length(public.directory_admin_audit_read('32000000-0000-4000-8000-000000000004',
  (data ->> 'id')::uuid) -> 'items')=5 from audit_fixture where label='saved'),'deleting actor/venue does not erase history');
reset role;
rollback;
