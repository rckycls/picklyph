-- Local synthetic fixtures only; all changes roll back. Times are two Manila days ahead.
begin;
create schema allocations_test;
create function allocations_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Allocation assertion failed: %',message; end if; end; $$;
create function allocations_test.expect_error(statement text, code text, hint text default null) returns void language plpgsql as $$
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
-- Manila wall clock two days ahead; minutes may exceed 1440 for the next day.
create function allocations_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date + 2)::timestamp + minute * interval '1 minute') at time zone 'Asia/Manila'; $$;
create function allocations_test.block(actor text, court text, request text, a integer, b integer) returns jsonb language sql as $$
select public.court_allocation_block(actor::uuid,court::uuid,request::uuid,allocations_test.at(a),allocations_test.at(b)); $$;
create function allocations_test.live(venue text) returns integer language sql as $$
select jsonb_array_length(public.court_allocation_read('71000000-0000-4000-8000-000000000003',venue::uuid,allocations_test.at(0),allocations_test.at(2880))->'allocations'); $$;
create function allocations_test.daily(a integer, b integer) returns jsonb language sql as $$
select jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',a,'end_minute',b,
  'rates',jsonb_build_array(jsonb_build_object('start_minute',a,'end_minute',b,'hourly_centavos',40000))))) from generate_series(1,7)),
  'exceptions','[]'::jsonb); $$;
-- Fixture lookup only; client roles still cannot read the table itself.
create function allocations_test.id(request text) returns uuid language sql security definer set search_path = '' as $$
select a.id from private.court_allocations a where a.request_id = request::uuid; $$;
grant usage on schema allocations_test to anon,authenticated,service_role;
grant execute on all functions in schema allocations_test to anon,authenticated,service_role;
-- 1 owner, 2 other player, 3 admin, 4 moderator.
insert into auth.users(id) values ('71000000-0000-4000-8000-000000000001'),('71000000-0000-4000-8000-000000000002'),
  ('71000000-0000-4000-8000-000000000003'),('71000000-0000-4000-8000-000000000004');
insert into private.account_roles(user_id,role) values ('71000000-0000-4000-8000-000000000003','admin'),
  ('71000000-0000-4000-8000-000000000004','moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('72000000-0000-4000-8000-000000000001','Allocation Fixture','1 Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  ('72000000-0000-4000-8000-000000000002','Allocation Draft','2 Fixture','Manila','Metro Manila',14.6,121,'draft','unclaimed'),
  ('72000000-0000-4000-8000-000000000003','Allocation Unconfigured','3 Fixture','Manila','Metro Manila',14.6,121,'approved','unclaimed');
insert into public.courts(id,venue_id,name,status) values
  ('73000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','A','active'),
  ('73000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000001','B','active'),
  ('73000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000001','C','inactive'),
  ('73000000-0000-4000-8000-000000000004','72000000-0000-4000-8000-000000000002','D','active'),
  ('73000000-0000-4000-8000-000000000005','72000000-0000-4000-8000-000000000003','E','active');
insert into private.venue_owners(user_id,venue_id) values ('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
-- Open 06:00-22:00 daily; the draft is open around the clock (cross-midnight coverage).
select public.venue_schedule_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001',null,allocations_test.daily(360,1320));
select public.venue_schedule_save('71000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000002',null,allocations_test.daily(0,1440));

-- Client roles and the trusted server role cannot bypass the commands.
set local role anon;
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000099',480,540)$q$,'42501');
select allocations_test.expect_error($q$select * from private.court_allocations$q$,'42501');
reset role;
set local role authenticated;
select allocations_test.expect_error($q$select public.court_allocation_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001',now(),now()+interval '1 day')$q$,'42501');
select allocations_test.expect_error($q$select private.allocation_acquire('73000000-0000-4000-8000-000000000001','block',now(),now(),null,'71000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000099')$q$,'42501');
select allocations_test.expect_error($q$insert into private.court_allocations(venue_id,court_id,kind,starts_at,ends_at,requested_by,request_id) values ('72000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','block',now(),now(),gen_random_uuid(),gen_random_uuid())$q$,'42501');
reset role;
set local role service_role;
select allocations_test.expect_error($q$select * from private.court_allocations$q$,'42501');
select allocations_test.expect_error($q$select private.allocation_release('74000000-0000-4000-8000-000000000099')$q$,'42501');
select allocations_test.expect_error($q$select private.allocation_renew('74000000-0000-4000-8000-000000000099',null)$q$,'42501');

-- Half-open intervals: adjacent and other-court blocks succeed; any overlap fails.
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001',480,540)->>'outcome'='created','owner block');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000002',540,600)->>'outcome'='created','adjacent after');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000003',420,480)->>'outcome'='created','adjacent before');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000004',510,570)$q$,'23P01','allocation_conflict');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000004',360,720)$q$,'23P01','allocation_conflict');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000004',480,540)->>'outcome'='created','other court same time');
-- Retries return the original once; a reused key with other parameters is refused.
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001',480,540)->>'outcome'='existing','retry');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001',600,660)$q$,'23505','request_reused');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000001',480,540)$q$,'23505','request_reused');
-- Bounds, alignment, hours and court/venue state.
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',615,660)$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',660,660)$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select public.court_allocation_block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',allocations_test.at(660)+interval '1 second',allocations_test.at(720))$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select public.court_allocation_block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',date_trunc('hour',now())-interval '2 hours',date_trunc('hour',now())-interval '1 hour')$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select public.court_allocation_block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001',null,allocations_test.at(660),allocations_test.at(720))$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000004','74000000-0000-4000-8000-000000000005',0,1470)$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',300,360)$q$,'23514','outside_hours');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000005',1290,1350)$q$,'23514','outside_hours');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000005','74000000-0000-4000-8000-000000000005',480,540)$q$,'23514','outside_hours');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000003','74000000-0000-4000-8000-000000000005',480,540)$q$,'P0002','court_unavailable');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000099','74000000-0000-4000-8000-000000000005',480,540)$q$,'P0002','court_unavailable');
-- Cross-midnight coverage of two contiguous days (admin may prepare a draft).
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000004','74000000-0000-4000-8000-000000000006',1380,1500)->>'outcome'='created','admin cross-midnight block');
-- Authorization: only current editors of this venue.
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000007',720,780)$q$,'42501','not_owner');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000004','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000007',720,780)$q$,'42501','not_owner');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000004','74000000-0000-4000-8000-000000000007',720,780)$q$,'42501','not_owner');
select allocations_test.expect_error($q$select public.court_allocation_read('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000001',now(),now()+interval '1 day')$q$,'42501','not_owner');
select allocations_test.expect_error($q$select public.court_allocation_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001',now(),now()+interval '32 days')$q$,'22023','invalid_input');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000007',720,780)->>'outcome'='created','admin block on owned venue');
select allocations_test.assert_that(allocations_test.live('72000000-0000-4000-8000-000000000001')=5,'five live blocks');
-- Release is idempotent and frees the interval.
select allocations_test.assert_that(public.court_allocation_release('71000000-0000-4000-8000-000000000001',allocations_test.id('74000000-0000-4000-8000-000000000007'))->>'outcome'='released','owner releases admin block');
select allocations_test.assert_that(public.court_allocation_release('71000000-0000-4000-8000-000000000001',allocations_test.id('74000000-0000-4000-8000-000000000007'))#>>'{allocation,state}'='released','release retry');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000008',720,780)->>'outcome'='created','released interval reusable');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000007',720,780)#>>'{allocation,state}'='released','released retry is not revived');
select allocations_test.expect_error($q$select public.court_allocation_release('71000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000099')$q$,'P0002','allocation_not_found');
select allocations_test.expect_error($q$select public.court_allocation_release('71000000-0000-4000-8000-000000000002',allocations_test.id('74000000-0000-4000-8000-000000000008'))$q$,'42501','not_owner');
reset role;

-- Holds (trusted primitive, as later booking commands will call it).
select allocations_test.assert_that(private.allocation_acquire('73000000-0000-4000-8000-000000000001','rental',allocations_test.at(840),allocations_test.at(900),clock_timestamp()+interval '300 milliseconds','71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000011')->>'outcome'='created','short hold');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000012',870,930)$q$,'23P01','allocation_conflict');
select allocations_test.expect_error($q$select public.court_allocation_release('71000000-0000-4000-8000-000000000001',allocations_test.id('74000000-0000-4000-8000-000000000011'))$q$,'42501','managed_allocation');
select allocations_test.assert_that(allocations_test.live('72000000-0000-4000-8000-000000000001')=6,'live hold counted');
select pg_sleep(0.4);
-- No sweep has run: the row is still active, yet reads and writes treat it as free.
select allocations_test.assert_that((select state='active' from private.court_allocations where request_id='74000000-0000-4000-8000-000000000011'),'unswept');
select allocations_test.assert_that(allocations_test.live('72000000-0000-4000-8000-000000000001')=5,'elapsed hold not counted');
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000012',870,930)->>'outcome'='created','block after hold elapsed');
select allocations_test.assert_that((select state='expired' and ended_at=expires_at from private.court_allocations where request_id='74000000-0000-4000-8000-000000000011'),'acquisition marked hold expired');
select allocations_test.assert_that(private.allocation_acquire('73000000-0000-4000-8000-000000000001','rental',allocations_test.at(840),allocations_test.at(900),clock_timestamp()+interval '1 hour','71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000011')#>>'{allocation,state}'='expired','retry never revives a hold');
select allocations_test.expect_error($q$select private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000011'),null)$q$,'55000','allocation_ended');
-- Renew: move a live hold, make it firm; caps match the locked hold rules.
select allocations_test.assert_that(private.allocation_acquire('73000000-0000-4000-8000-000000000002','session',allocations_test.at(840),allocations_test.at(960),clock_timestamp()+interval '2 hours','71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000013')->>'outcome'='created','two-hour hold');
select allocations_test.expect_error($q$select private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),clock_timestamp()+interval '121 minutes')$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),clock_timestamp()-interval '1 second')$q$,'22023','invalid_input');
select allocations_test.assert_that(private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),clock_timestamp()+interval '15 minutes')->>'outcome'='renewed','payment hold');
select allocations_test.assert_that(private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),null)#>>'{allocation,expires_at}' is null,'firm');
select allocations_test.assert_that(private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),null)->>'outcome'='existing','firm retry');
select allocations_test.expect_error($q$select private.allocation_renew(allocations_test.id('74000000-0000-4000-8000-000000000013'),clock_timestamp()+interval '5 minutes')$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select private.allocation_acquire('73000000-0000-4000-8000-000000000002','rental',allocations_test.at(1020),allocations_test.at(1080),clock_timestamp()+interval '3 hours','71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000014')$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select private.allocation_acquire('73000000-0000-4000-8000-000000000002','rental',allocations_test.at(1020),allocations_test.at(1080),allocations_test.at(1050),'71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000014')$q$,'22023','invalid_input');
select allocations_test.expect_error($q$select private.allocation_acquire('73000000-0000-4000-8000-000000000002','lesson',allocations_test.at(1020),allocations_test.at(1080),null,'71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000014')$q$,'22023','invalid_input');
-- Releasing an elapsed hold reports it expired; it had already stopped consuming.
select private.allocation_acquire('73000000-0000-4000-8000-000000000002','rental',allocations_test.at(1020),allocations_test.at(1080),clock_timestamp()+interval '200 milliseconds','71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000015');
select pg_sleep(0.3);
select allocations_test.assert_that(private.allocation_release(allocations_test.id('74000000-0000-4000-8000-000000000015'))#>>'{allocation,state}'='expired','elapsed release');
select allocations_test.assert_that(private.allocation_release(allocations_test.id('74000000-0000-4000-8000-000000000013'))->>'outcome'='released','trusted release of a session');

-- The constraint is a backstop even for a trusted direct insert.
select allocations_test.expect_error($q$insert into private.court_allocations(venue_id,court_id,kind,starts_at,ends_at,requested_by,request_id) values ('72000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','block',allocations_test.at(510),allocations_test.at(570),gen_random_uuid(),gen_random_uuid())$q$,'23P01');
select allocations_test.expect_error($q$insert into private.court_allocations(venue_id,court_id,kind,starts_at,ends_at,requested_by,request_id) values ('72000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','block',allocations_test.at(1020),allocations_test.at(1050)+interval '1 minute',gen_random_uuid(),gen_random_uuid())$q$,'23514');
-- Rollback: a failed caller transaction leaves no inventory behind.
savepoint caller;
select private.allocation_acquire('73000000-0000-4000-8000-000000000002','rental',allocations_test.at(1140),allocations_test.at(1200),null,'71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000016');
rollback to caller;
select allocations_test.assert_that(not exists(select 1 from private.court_allocations where request_id='74000000-0000-4000-8000-000000000016'),'rolled back');
create function allocations_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'Fixture audit failure'; end; $$;
create trigger allocations_test_audit before insert on private.directory_audit_events for each row execute function allocations_test.fail_audit();
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000017',1140,1200)$q$,'P0001');
drop trigger allocations_test_audit on private.directory_audit_events;
select allocations_test.assert_that(not exists(select 1 from private.court_allocations where request_id='74000000-0000-4000-8000-000000000017'),'audit failure rolls back the block');
select allocations_test.assert_that((select count(*)=8 from private.directory_audit_events where action='allocation.block'
  and target_venue_id in ('72000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002')),'one audit per created block, none on retry');
select allocations_test.assert_that((select count(*)=1 from private.directory_audit_events where action='allocation.release'
  and target_venue_id='72000000-0000-4000-8000-000000000001'),'one audit per release');
-- Manila hours do not depend on the database time zone.
set local time zone 'America/New_York';
set local role service_role;
select allocations_test.assert_that(allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000018',360,420)->>'outcome'='created','DB time zone independent');
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000019',330,390)$q$,'23514','outside_hours');
reset role;
-- Revocation, suspension and deactivation take effect at the next command.
delete from private.venue_owners where user_id='71000000-0000-4000-8000-000000000001';
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000019',1140,1200)$q$,'42501','not_owner');
select allocations_test.expect_error($q$select public.court_allocation_release('71000000-0000-4000-8000-000000000001',allocations_test.id('74000000-0000-4000-8000-000000000008'))$q$,'42501','not_owner');
-- T22: a court with live inventory stays active, even for trusted SQL, until it is released.
select allocations_test.expect_error($q$update public.courts set status='inactive' where id='73000000-0000-4000-8000-000000000002'$q$,'55006','court_allocated');
select private.allocation_release(allocations_test.id('74000000-0000-4000-8000-000000000004')),
  private.allocation_release(allocations_test.id('74000000-0000-4000-8000-000000000018'));
update public.courts set status='inactive' where id='73000000-0000-4000-8000-000000000002';
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000019',1140,1200)$q$,'P0002','court_unavailable');
update public.venues set publication_status='suspended' where id='72000000-0000-4000-8000-000000000001';
select allocations_test.expect_error($q$select allocations_test.block('71000000-0000-4000-8000-000000000003','73000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000019',1140,1200)$q$,'P0002','venue_unavailable');
select allocations_test.expect_error($q$select private.allocation_acquire('73000000-0000-4000-8000-000000000001','rental',allocations_test.at(1140),allocations_test.at(1200),null,'71000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000019')$q$,'P0002','venue_unavailable');
select allocations_test.expect_error($q$select public.court_allocation_read('71000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000001',now(),now()+interval '1 day')$q$,'P0002','venue_unavailable');
rollback;
