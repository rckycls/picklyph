-- Local synthetic fixtures only; all changes roll back. Times are two Manila days ahead.
begin;
create schema calendar_test;
create function calendar_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Calendar assertion failed: %',message; end if; end; $$;
create function calendar_test.expect_error(statement text, code text, hint text default null) returns void language plpgsql as $$
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
create function calendar_test.day(offset_days integer) returns date language sql stable as $$
select (now() at time zone 'Asia/Manila')::date + offset_days; $$;
-- Manila wall clock two days ahead; minutes may exceed 1440 for the next day.
create function calendar_test.at(minute integer) returns timestamptz language sql stable as $$
select (calendar_test.day(2)::timestamp + minute * interval '1 minute') at time zone 'Asia/Manila'; $$;
create function calendar_test.block(actor text, court text, request text, a integer, b integer) returns jsonb language sql as $$
select public.court_allocation_block(actor::uuid,court::uuid,request::uuid,calendar_test.at(a),calendar_test.at(b)); $$;
-- Same windows every day; closures are day offsets from today.
create function calendar_test.hours(windows jsonb, closure_days integer[] default '{}') returns jsonb language sql stable as $$
select jsonb_build_object('weekly',case when windows is null then null else (select jsonb_agg(windows) from generate_series(1,7)) end,
  'closures',coalesce((select jsonb_agg(to_char(calendar_test.day(d),'YYYY-MM-DD') order by d) from unnest(closure_days) d),'[]'::jsonb)); $$;
create function calendar_test.save_court(actor text, court text, revision text, hours jsonb) returns jsonb language sql as $$
select public.court_hours_save(actor::uuid,court::uuid,revision,hours); $$;
-- One rate band per window; closed_days become empty dated exceptions.
create function calendar_test.venue_hours(a integer, b integer, closed_days integer[] default '{}') returns jsonb language sql stable as $$
select jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',a,'end_minute',b,
  'rates',jsonb_build_array(jsonb_build_object('start_minute',a,'end_minute',b,'hourly_centavos',40000))))) from generate_series(1,7)),
  'exceptions',coalesce((select jsonb_agg(jsonb_build_object('date',to_char(calendar_test.day(d),'YYYY-MM-DD'),'windows','[]'::jsonb) order by d)
    from unnest(closed_days) d),'[]'::jsonb)); $$;
create function calendar_test.venue_revision(venue text) returns text language sql security definer set search_path = '' as $$
select s.revision::text from private.venue_schedules s where s.venue_id = venue::uuid; $$;
create function calendar_test.save_venue(actor text, venue text, hours jsonb) returns jsonb language sql as $$
select public.venue_schedule_save(actor::uuid,venue::uuid,calendar_test.venue_revision(venue),hours); $$;
create function calendar_test.read(actor text, venue text, offset_days integer, days integer) returns jsonb language sql as $$
select public.owner_calendar_read(actor::uuid,venue::uuid,calendar_test.day(offset_days),days); $$;
create function calendar_test.intervals(court text, offset_days integer, days integer) returns jsonb language sql security definer set search_path = '' as $$
select private.resolve_court_hours(court::uuid,calendar_test.day(offset_days),days); $$;
-- Fixture lookups only; client roles still cannot read the tables themselves.
create function calendar_test.id(request text) returns uuid language sql security definer set search_path = '' as $$
select a.id from private.court_allocations a where a.request_id = request::uuid; $$;
create function calendar_test.revision(court text) returns text language sql security definer set search_path = '' as $$
select s.revision::text from private.court_schedules s where s.court_id = court::uuid; $$;
create function calendar_test.rules(court text) returns jsonb language sql security definer set search_path = '' as $$
select private.court_hours_json(court::uuid); $$;
-- T18 owner command; definer only for the fixture's version/name lookups.
create function calendar_test.deactivate(actor text, court text) returns jsonb language sql security definer set search_path = '' as $$
select public.owner_venue_save(actor::uuid,'82000000-0000-4000-8000-000000000001',
  (select updated_at from public.venues where id='82000000-0000-4000-8000-000000000001'),
  '{"name":"Calendar Fixture","address_line":"1 Fixture","city":"Manila","province":"Metro Manila"}',
  jsonb_build_array(jsonb_build_object('id',court,'name',(select name from public.courts where id=court::uuid),
    'surface',null,'is_indoor',false,'is_covered',false,'status','inactive'))); $$;
grant usage on schema calendar_test to anon,authenticated,service_role;
grant execute on all functions in schema calendar_test to anon,authenticated,service_role;
-- 1 owner, 2 other player, 3 admin, 4 moderator.
insert into auth.users(id) values ('81000000-0000-4000-8000-000000000001'),('81000000-0000-4000-8000-000000000002'),
  ('81000000-0000-4000-8000-000000000003'),('81000000-0000-4000-8000-000000000004');
insert into private.account_roles(user_id,role) values ('81000000-0000-4000-8000-000000000003','admin'),
  ('81000000-0000-4000-8000-000000000004','moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('82000000-0000-4000-8000-000000000001','Calendar Fixture','1 Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  ('82000000-0000-4000-8000-000000000002','Calendar Overnight','2 Fixture','Manila','Metro Manila',14.6,121,'draft','unclaimed');
insert into public.courts(id,venue_id,name,status) values
  ('83000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001','A','active'),
  ('83000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001','B','active'),
  ('83000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000001','C','inactive'),
  ('83000000-0000-4000-8000-000000000004','82000000-0000-4000-8000-000000000002','D','active');
insert into private.venue_owners(user_id,venue_id) values ('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001');
-- Venue open 06:00-22:00 daily at PHP 400 until 17:00, then PHP 600.
select public.venue_schedule_save('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',360,'end_minute',1320,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',360,'end_minute',1020,'hourly_centavos',40000),
    jsonb_build_object('start_minute',1020,'end_minute',1320,'hourly_centavos',60000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
-- Overnight draft venue open 22:00-02:00 daily (admin-managed).
select public.venue_schedule_save('81000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000002',null,calendar_test.venue_hours(1320,1560));

-- Client roles and the trusted server role cannot bypass the commands or read rules.
set local role anon;
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001',null,calendar_test.hours(null))$q$,'42501');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)$q$,'42501');
reset role;
set local role authenticated;
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)$q$,'42501');
select calendar_test.expect_error($q$select * from private.court_hours$q$,'42501');
select calendar_test.expect_error($q$select private.resolve_court_hours('83000000-0000-4000-8000-000000000001',current_date,1)$q$,'42501');
reset role;
set local role service_role;
select calendar_test.expect_error($q$select * from private.court_schedules$q$,'42501');
select calendar_test.expect_error($q$insert into private.court_closures values ('83000000-0000-4000-8000-000000000001',current_date)$q$,'42501');
select calendar_test.expect_error($q$select private.court_within_hours('83000000-0000-4000-8000-000000000001',now(),now())$q$,'42501');

-- Court hours: current editors only; strict input; independent revisions.
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000002','83000000-0000-4000-8000-000000000001',null,calendar_test.hours(null))$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000004','83000000-0000-4000-8000-000000000001',null,calendar_test.hours(null))$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000004',null,calendar_test.hours(null))$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000099',null,calendar_test.hours(null))$q$,'P0002','court_unavailable');
select calendar_test.expect_error(format($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001',null,%L)$q$,bad),'22023','invalid_input')
from unnest(array[
  '{"weekly":null}', '{"weekly":null,"closures":[],"extra":1}', '{"weekly":[],"closures":[]}', '{"weekly":{},"closures":[]}',
  calendar_test.hours('[{"start_minute":480,"end_minute":480}]')::text, calendar_test.hours('[{"start_minute":480,"end_minute":1470}]')::text,
  calendar_test.hours('[{"start_minute":1440,"end_minute":1470}]')::text, calendar_test.hours('[{"start_minute":495,"end_minute":600}]')::text,
  calendar_test.hours('[{"start_minute":480,"end_minute":720},{"start_minute":690,"end_minute":900}]')::text,
  calendar_test.hours('[{"start_minute":480,"end_minute":720,"rates":[]}]')::text,
  calendar_test.hours('[{"start_minute":0,"end_minute":60},{"start_minute":60,"end_minute":120},{"start_minute":120,"end_minute":180},{"start_minute":180,"end_minute":240},{"start_minute":240,"end_minute":300}]')::text,
  '{"weekly":null,"closures":["2026-02-30"]}', '{"weekly":null,"closures":["1999-12-31"]}', '{"weekly":null,"closures":[20261012]}',
  '{"weekly":null,"closures":["2026-10-12","2026-10-12"]}',
  jsonb_build_object('weekly',null,'closures',(select jsonb_agg(to_char(date '2030-01-01' + n,'YYYY-MM-DD')) from generate_series(0,120) n))::text
]) bad;
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','01',calendar_test.hours(null))$q$,'22023','invalid_input');
-- Court A: 08:00-12:00 and 16:00-20:00 every day, closed three days ahead.
select calendar_test.assert_that(calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001',null,
  calendar_test.hours('[{"start_minute":480,"end_minute":720},{"start_minute":960,"end_minute":1200}]','{3}'))->>'revision'='1','first court save');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001',null,calendar_test.hours(null))$q$,'40001','version_conflict');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','2',calendar_test.hours(null))$q$,'40001','version_conflict');
select calendar_test.assert_that(calendar_test.revision('83000000-0000-4000-8000-000000000001')='1','conflicts leave the revision');
select calendar_test.assert_that((select jsonb_array_length(h->'hours'->'weekly')=7 and jsonb_array_length(h->'hours'->'weekly'->0)=2
  and h->'hours'->'closures'->>0=to_char(calendar_test.day(3),'YYYY-MM-DD') and h->>'court_id'='83000000-0000-4000-8000-000000000001'
  from (select calendar_test.rules('83000000-0000-4000-8000-000000000001') h) x),'court rules round-trip');
select calendar_test.assert_that(calendar_test.rules('83000000-0000-4000-8000-000000000002')
  ='{"court_id":"83000000-0000-4000-8000-000000000002","revision":null,"hours":{"weekly":null,"closures":[]}}'::jsonb,'unconfigured court follows venue');

-- Resolution: court windows intersect venue intervals, keeping venue rates.
select calendar_test.assert_that((select jsonb_array_length(i)=3
  and (i->0->>'starts_at')::timestamptz=calendar_test.at(480) and (i->0->>'ends_at')::timestamptz=calendar_test.at(720)
  and (i->1->>'starts_at')::timestamptz=calendar_test.at(960) and (i->1->>'ends_at')::timestamptz=calendar_test.at(1020) and (i->1->>'hourly_centavos')::bigint=40000
  and (i->2->>'starts_at')::timestamptz=calendar_test.at(1020) and (i->2->>'ends_at')::timestamptz=calendar_test.at(1200) and (i->2->>'hourly_centavos')::bigint=60000
  from (select calendar_test.intervals('83000000-0000-4000-8000-000000000001',2,1) i) x),'court A narrowed with rates');
select calendar_test.assert_that(jsonb_array_length(calendar_test.intervals('83000000-0000-4000-8000-000000000002',2,1))=2,'court B follows venue bands');
select calendar_test.assert_that(jsonb_array_length(calendar_test.intervals('83000000-0000-4000-8000-000000000001',3,1))=0,'court closure closes the whole date');
select calendar_test.assert_that(jsonb_array_length(calendar_test.intervals('83000000-0000-4000-8000-000000000001',2,2))=3,'closed next date adds nothing');

-- Acquisitions use court hours, including the gap between windows and closures.
select calendar_test.expect_error($q$select calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',420,480)$q$,'23514','outside_hours');
select calendar_test.expect_error($q$select calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',690,990)$q$,'23514','outside_hours');
select calendar_test.expect_error($q$select calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',1920,1980)$q$,'23514','outside_hours');
select calendar_test.assert_that(calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000001',480,540)->>'outcome'='created','A block inside court hours');
select calendar_test.assert_that(calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000002',360,420)->>'outcome'='created','B block inside venue hours');

-- Court-hours saves cannot displace live allocations; following the venue can.
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','1',calendar_test.hours('[{"start_minute":540,"end_minute":720}]'))$q$,'55006','hours_conflict');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','1',calendar_test.hours(null,'{2}'))$q$,'55006','hours_conflict');
select calendar_test.assert_that(calendar_test.revision('83000000-0000-4000-8000-000000000001')='1','refused saves roll back');
select calendar_test.assert_that(calendar_test.save_court('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000001','1',calendar_test.hours(null,'{3}'))->>'revision'='2','admin saves; A follows venue');
select calendar_test.assert_that(jsonb_array_length(calendar_test.intervals('83000000-0000-4000-8000-000000000001',2,1))=2,'A follows venue bands');

-- Venue schedule saves cannot displace live allocations; released, expired and past rows do not count.
select calendar_test.expect_error($q$select calendar_test.save_venue('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',calendar_test.venue_hours(420,1320))$q$,'55006','hours_conflict');
select calendar_test.expect_error($q$select calendar_test.save_venue('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',calendar_test.venue_hours(360,1320,'{2}'))$q$,'55006','hours_conflict');
select calendar_test.assert_that(calendar_test.venue_revision('82000000-0000-4000-8000-000000000001')='1','venue revision unchanged');
select public.court_allocation_release('81000000-0000-4000-8000-000000000001',calendar_test.id('84000000-0000-4000-8000-000000000002'));
reset role;
insert into private.court_allocations(venue_id,court_id,kind,starts_at,ends_at,requested_by,request_id) values
  ('82000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','block',calendar_test.at(360)-interval '3 days',
   calendar_test.at(420)-interval '3 days','81000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000003');
select calendar_test.assert_that(calendar_test.save_venue('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',calendar_test.venue_hours(420,1320))->>'revision'='2','released and past rows ignored');
-- Trusted primitive, as later booking commands will call it.
select private.allocation_acquire('83000000-0000-4000-8000-000000000002','rental',calendar_test.at(420),calendar_test.at(480),clock_timestamp()+interval '300 milliseconds',
  '81000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000004');
set local role service_role;
select calendar_test.expect_error($q$select calendar_test.save_venue('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',calendar_test.venue_hours(480,1320))$q$,'55006','hours_conflict');
select calendar_test.assert_that(jsonb_array_length(calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)->'allocations')=2,'live hold listed');
select pg_sleep(0.4);
select calendar_test.assert_that(jsonb_array_length(calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)->'allocations')=1,'elapsed hold not listed');
select calendar_test.assert_that(calendar_test.save_venue('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',calendar_test.venue_hours(480,1320))->>'revision'='3','elapsed hold no longer protects');
select calendar_test.assert_that(calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000005',3480,3540)->>'outcome'='created','block on a later date');

-- Calendar: one coherent read of courts, their hours and live inventory.
select calendar_test.assert_that((select c->>'venue_id'='82000000-0000-4000-8000-000000000001' and c->>'name'='Calendar Fixture' and c->>'days'='1'
  and c->>'start_date'=to_char(calendar_test.day(2),'YYYY-MM-DD') and c->>'schedule_revision'='3' and (c->>'at')::timestamptz<=clock_timestamp()
  and jsonb_array_length(c->'courts')=3 and c->'courts'->0->>'name'='A' and c->'courts'->0->>'revision'='2' and c->'courts'->0->'hours'->'weekly'='null'::jsonb
  and c->'courts'->2->>'status'='inactive' and jsonb_array_length(c->'courts'->0->'intervals')=1
  and jsonb_array_length(c->'allocations')=1 and c->'allocations'->0->>'kind'='block'
  from (select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1) c) x),'calendar shape');
select calendar_test.assert_that(jsonb_array_length(calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,7)->'allocations')=2,'seven-day range');
select calendar_test.assert_that(jsonb_array_length(calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',3,1)->'courts'->0->'intervals')=0,'calendar shows court closure');
select calendar_test.assert_that(jsonb_array_length(calendar_test.read('81000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000001',2,1)->'courts')=3,'admin reads');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,8)$q$,'22023','invalid_input');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,0)$q$,'22023','invalid_input');
select calendar_test.expect_error($q$select public.owner_calendar_read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',date '2099-12-30',3)$q$,'22023','invalid_input');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000002','82000000-0000-4000-8000-000000000001',2,1)$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000004','82000000-0000-4000-8000-000000000001',2,1)$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002',2,1)$q$,'42501','not_owner');

-- Overnight venue: same-day court windows meet at midnight and cover a cross-midnight block.
select calendar_test.assert_that(calendar_test.save_court('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004',null,
  calendar_test.hours('[{"start_minute":0,"end_minute":60},{"start_minute":1380,"end_minute":1440}]'))->>'revision'='1','admin court hours on a draft');
select calendar_test.assert_that((select jsonb_array_length(i)=4 and (i->0->>'starts_at')::timestamptz=calendar_test.at(0) and (i->0->>'ends_at')::timestamptz=calendar_test.at(60)
  and (i->1->>'starts_at')::timestamptz=calendar_test.at(1380) and (i->2->>'starts_at')::timestamptz=calendar_test.at(1440)
  from (select calendar_test.intervals('83000000-0000-4000-8000-000000000004',2,2) i) x),'overnight intersection');
select calendar_test.assert_that(calendar_test.block('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004','84000000-0000-4000-8000-000000000006',1380,1500)->>'outcome'='created','cross-midnight block');
select calendar_test.expect_error($q$select calendar_test.block('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004','84000000-0000-4000-8000-000000000007',1320,1380)$q$,'23514','outside_hours');
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000004','1',calendar_test.hours('[{"start_minute":0,"end_minute":60},{"start_minute":1380,"end_minute":1440}]','{3}'))$q$,'55006','hours_conflict');
select calendar_test.expect_error($q$select calendar_test.save_venue('81000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000002',calendar_test.venue_hours(1320,1470))$q$,'55006','hours_conflict');

-- Court deactivation: refused while live inventory remains, on every path.
select calendar_test.expect_error($q$select calendar_test.deactivate('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001')$q$,'55006','court_allocated');
reset role;
select calendar_test.expect_error($q$update public.courts set status='inactive' where id='83000000-0000-4000-8000-000000000001'$q$,'55006','court_allocated');
select calendar_test.expect_error($q$update public.courts set status='inactive' where id='83000000-0000-4000-8000-000000000004'$q$,'55006','court_allocated');
set local role service_role;
-- B has only released, elapsed and past rows: it may be deactivated and reactivated.
select calendar_test.assert_that(jsonb_array_length(calendar_test.deactivate('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002')->'courts')=3,'B deactivated');
reset role;
update public.courts set status='active' where id='83000000-0000-4000-8000-000000000002';
set local role service_role;
select public.court_allocation_release('81000000-0000-4000-8000-000000000001',calendar_test.id('84000000-0000-4000-8000-000000000001'));
select calendar_test.expect_error($q$select calendar_test.deactivate('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001')$q$,'55006','court_allocated');
select public.court_allocation_release('81000000-0000-4000-8000-000000000001',calendar_test.id('84000000-0000-4000-8000-000000000005'));
select calendar_test.assert_that(calendar_test.deactivate('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000001')->'courts'->0->>'status'='inactive','A deactivated after release');
reset role;

-- Audit: one row per successful court-hours save, none for refusals; audit failure rolls back.
select calendar_test.assert_that((select count(*)=3 from private.directory_audit_events where action='schedule.court_update'
  and target_venue_id in ('82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002')),'court-hours audits');
select calendar_test.assert_that((select count(*)=4 from private.directory_audit_events where action='schedule.update'
  and target_venue_id in ('82000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000002')),'venue schedule audits');
create function calendar_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'Fixture audit failure'; end; $$;
create trigger calendar_test_audit before insert on private.directory_audit_events for each row execute function calendar_test.fail_audit();
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002',null,calendar_test.hours(null,'{5}'))$q$,'P0001');
drop trigger calendar_test_audit on private.directory_audit_events;
select calendar_test.assert_that(calendar_test.revision('83000000-0000-4000-8000-000000000002') is null,'audit failure rolls back the court rules');
-- Manila hours do not depend on the database time zone.
set local time zone 'America/New_York';
set local role service_role;
select calendar_test.assert_that(calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002',null,
  calendar_test.hours('[{"start_minute":600,"end_minute":660}]'))->>'revision'='1','B custom hours');
select calendar_test.assert_that(calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000008',600,660)->>'outcome'='created','DB time zone independent');
select calendar_test.expect_error($q$select calendar_test.block('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','84000000-0000-4000-8000-000000000009',660,720)$q$,'23514','outside_hours');
select calendar_test.assert_that((select (i->0->>'starts_at')::timestamptz=calendar_test.at(600)
  from (select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)->'courts'->1->'intervals' i) x),'calendar time zone independent');
reset role;
-- Revocation and suspension take effect at the next command.
delete from private.venue_owners where user_id='81000000-0000-4000-8000-000000000001';
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000001','83000000-0000-4000-8000-000000000002','1',calendar_test.hours(null))$q$,'42501','not_owner');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000001','82000000-0000-4000-8000-000000000001',2,1)$q$,'42501','not_owner');
update public.venues set publication_status='suspended' where id='82000000-0000-4000-8000-000000000001';
select calendar_test.expect_error($q$select calendar_test.save_court('81000000-0000-4000-8000-000000000003','83000000-0000-4000-8000-000000000002','1',calendar_test.hours(null))$q$,'P0002','venue_unavailable');
select calendar_test.expect_error($q$select calendar_test.read('81000000-0000-4000-8000-000000000003','82000000-0000-4000-8000-000000000001',2,1)$q$,'P0002','venue_unavailable');
rollback;
