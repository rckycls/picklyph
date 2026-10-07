-- Local synthetic fixtures only; all changes roll back.
begin;
create schema schedules_test;
create function schedules_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Schedule assertion failed: %',message; end if; end; $$;
create function schedules_test.expect_error(statement text, code text, hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then
    get stacked diagnostics actual_hint = pg_exception_hint;
    if sqlstate = code and (hint is null or hint = actual_hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected error: %',statement;
end; $$;
create function schedules_test.rules() returns jsonb language sql as $$
select '{"weekly":[[],[{"start_minute":1320,"end_minute":1560,"rates":[{"start_minute":1320,"end_minute":1440,"hourly_centavos":25000},{"start_minute":1440,"end_minute":1560,"hourly_centavos":30000}]}],[],[],[],[],[]],"exceptions":[{"date":"2026-10-06","windows":[]}]}'::jsonb; $$;
grant usage on schema schedules_test to anon,authenticated,service_role;
grant execute on all functions in schema schedules_test to anon,authenticated,service_role;
insert into auth.users(id) values ('61000000-0000-4000-8000-000000000001'),('61000000-0000-4000-8000-000000000002'),
  ('61000000-0000-4000-8000-000000000003'),('61000000-0000-4000-8000-000000000004');
insert into private.account_roles(user_id,role) values ('61000000-0000-4000-8000-000000000003','admin'),
  ('61000000-0000-4000-8000-000000000004','moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('62000000-0000-4000-8000-000000000001','Schedule Fixture','1 Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  ('62000000-0000-4000-8000-000000000002','Schedule Draft','2 Fixture','Manila','Metro Manila',14.6,121,'draft','unclaimed');
insert into private.venue_owners(user_id,venue_id) values ('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001');
set local role anon;
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001',null,schedules_test.rules())$q$,'42501');
select schedules_test.expect_error($q$select * from private.schedule_rates$q$,'42501');
reset role;
set local role authenticated;
select schedules_test.expect_error($q$select public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-05',2)$q$,'42501');
select schedules_test.expect_error($q$insert into private.venue_schedules values ('62000000-0000-4000-8000-000000000001',1)$q$,'42501');
reset role;
set local role service_role;
select schedules_test.expect_error($q$select private.resolve_venue_schedule('62000000-0000-4000-8000-000000000001','2026-10-05',2)$q$,'42501');
select schedules_test.expect_error($q$select * from private.schedule_windows$q$,'42501');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000001',null,schedules_test.rules())$q$,'42501','not_owner');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000004','62000000-0000-4000-8000-000000000001',null,schedules_test.rules())$q$,'42501','not_owner');
select schedules_test.assert_that(public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-05',2)->'schedule' = 'null','unconfigured is distinct from explicitly closed');
select schedules_test.assert_that(public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001',null,schedules_test.rules())->>'revision' = '1','owner first save');
select schedules_test.assert_that(public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-06',1)->'intervals' = '[]','closure stops spill');
select schedules_test.assert_that((public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-05',1)->'intervals'->0->>'starts_at')::timestamptz = '2026-10-05T14:00:00Z','Manila UTC conversion');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001',null,schedules_test.rules())$q$,'40001','version_conflict');
select schedules_test.assert_that(public.venue_schedule_save('61000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000002',null,schedules_test.rules())->>'revision' = '1','admin may prepare a draft');
select schedules_test.expect_error($q$select public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-05',32)$q$,'22023','invalid_input');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','1',jsonb_set(schedules_test.rules(),'{weekly,1,0,rates,1,start_minute}','1470'))$q$,'22023','invalid_input');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','1',jsonb_set(schedules_test.rules(),'{weekly,1,0,rates,1,hourly_centavos}','9007199254740992'))$q$,'22023','invalid_input');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','1',jsonb_set(schedules_test.rules(),'{exceptions,0,date}','"2026-02-30"'))$q$,'22023','invalid_input');
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','1',jsonb_set(schedules_test.rules(),'{weekly,2}','[{"start_minute":60,"end_minute":180,"rates":[{"start_minute":60,"end_minute":180,"hourly_centavos":1}]}]'))$q$,'22023','invalid_input');
reset role;
select schedules_test.assert_that((select revision=1 from private.venue_schedules where venue_id='62000000-0000-4000-8000-000000000001'),'invalid writes do not change version');
select schedules_test.assert_that((select count(*)=2 from private.directory_audit_events where action='schedule.update'),'one audit for each successful save');
-- Database time-zone setting must never alter the instants.
set local time zone 'America/New_York';
select schedules_test.assert_that((private.resolve_venue_schedule('62000000-0000-4000-8000-000000000001','2026-10-05',1)->0->>'starts_at')::timestamptz = '2026-10-05T14:00:00Z','DB timezone independent');
-- Audit failure must roll back the revision and all replacement rows.
create function schedules_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'Fixture audit failure'; end; $$;
create trigger schedules_test_audit before insert on private.directory_audit_events for each row execute function schedules_test.fail_audit();
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','1',schedules_test.rules())$q$,'P0001');
select schedules_test.assert_that((select revision=1 from private.venue_schedules where venue_id='62000000-0000-4000-8000-000000000001'),'audit failure rolls back version');
drop trigger schedules_test_audit on private.directory_audit_events;
delete from private.venue_owners where user_id='61000000-0000-4000-8000-000000000001';
select schedules_test.expect_error($q$select public.venue_schedule_read('61000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','2026-10-05',1)$q$,'42501','not_owner');
update public.venues set publication_status='suspended' where id='62000000-0000-4000-8000-000000000001';
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000001','1',schedules_test.rules())$q$,'P0002','venue_unavailable');
delete from private.account_roles where user_id='61000000-0000-4000-8000-000000000003';
select schedules_test.expect_error($q$select public.venue_schedule_save('61000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000002','1',schedules_test.rules())$q$,'42501','not_owner');
rollback;
