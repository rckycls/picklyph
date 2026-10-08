-- Rollback-only fixtures, relative to the database clock.
begin;
create schema session_test;
create function session_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Session assertion failed: %',message; end if; end; $$;
create function session_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function session_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function session_test.input(request text,courts jsonb default '["c3000000-0000-4000-8000-000000000001","c3000000-0000-4000-8000-000000000002"]',a integer default 600,b integer default 720)
returns jsonb language sql stable as $$
select jsonb_build_object('venue_id','c2000000-0000-4000-8000-000000000001','request_id',request,'court_ids',coalesce(courts,'["c3000000-0000-4000-8000-000000000001","c3000000-0000-4000-8000-000000000002"]'::jsonb),
  'title','Open play','starts_at',session_test.at(a),'ends_at',session_test.at(b),'capacity',12,'group_limit',4,'price_centavos',25000); $$;
create function session_test.create_as(actor text,input jsonb) returns jsonb language sql as $$
select public.owner_session_create(actor::uuid,input); $$;
create function session_test.create(input jsonb) returns jsonb language sql as $$
select session_test.create_as('c1000000-0000-4000-8000-000000000001',input); $$;
create function session_test.id(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=request::uuid; $$;
create function session_test.cancel(request text) returns jsonb language sql as $$
select public.owner_session_cancel('c1000000-0000-4000-8000-000000000001',session_test.id(request)); $$;
grant usage on schema session_test to anon,authenticated,service_role;
grant execute on all functions in schema session_test to anon,authenticated,service_role;
insert into auth.users(id) values ('c1000000-0000-4000-8000-000000000001'),('c1000000-0000-4000-8000-000000000002'),
  ('c1000000-0000-4000-8000-000000000003'),('c1000000-0000-4000-8000-000000000004');
insert into private.account_roles(user_id,role) values ('c1000000-0000-4000-8000-000000000003','admin'),('c1000000-0000-4000-8000-000000000004','moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('c2000000-0000-4000-8000-000000000001','Sessions Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  ('c2000000-0000-4000-8000-000000000002','Other Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) values
  ('c3000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','A','active'),
  ('c3000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000001','B','active'),
  ('c3000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000002','Other','active'),
  ('c3000000-0000-4000-8000-000000000004','c2000000-0000-4000-8000-000000000001','Inactive','inactive');
insert into private.venue_owners(user_id,venue_id) values ('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001');
select public.venue_schedule_save('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));

set local role anon;
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001'))$q$,'42501');
reset role;
set local role authenticated;
select session_test.expect_error($q$select public.owner_session_read('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001')$q$,'42501');
select session_test.expect_error($q$select * from private.open_play_sessions$q$,'42501');
reset role;
set local role service_role;
select session_test.expect_error($q$select * from private.session_courts$q$,'42501');
select session_test.expect_error($q$select private.session_json(null,now())$q$,'42501');
select session_test.expect_error(format($q$select session_test.create_as(%L,session_test.input('c4000000-0000-4000-8000-000000000001'))$q$,actor),'42501','not_owner')
  from unnest(array['c1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000004']) actor;
select session_test.expect_error(format($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001')||%L::jsonb)$q$,bad),'22023','invalid_input')
  from unnest(array['{"actor_user_id":"x"}','{"capacity":0}','{"capacity":201}','{"group_limit":13}','{"group_limit":0}',
    '{"price_centavos":-1}','{"price_centavos":0.5}','{"price_centavos":9007199254740991}','{"title":""}',
    '{"court_ids":[]}','{"court_ids":["c3000000-0000-4000-8000-000000000001","c3000000-0000-4000-8000-000000000001"]}',
    '{"starts_at":"infinity"}','{"starts_at":"2026-10-01"}']) bad;
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001','["c3000000-0000-4000-8000-000000000003"]'))$q$,'P0002','court_unavailable');
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001','["c3000000-0000-4000-8000-000000000004"]'))$q$,'P0002','court_unavailable');
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001')||jsonb_build_object('starts_at',now(),'ends_at',now()+interval '1 hour'))$q$,'22023','invalid_input');
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001')||jsonb_build_object('starts_at',session_test.at(90000),'ends_at',session_test.at(90060)))$q$,'22023','invalid_input');
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001',null,601,720))$q$,'22023','invalid_input');
-- A session reserves both courts; order and timestamp spelling do not change retry identity.
select session_test.assert_that(session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001'))->>'outcome'='created','created');
set local timezone='America/New_York';
select session_test.assert_that(session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001',
  '["c3000000-0000-4000-8000-000000000002","c3000000-0000-4000-8000-000000000001"]'))->>'outcome'='existing','canonical retry');
set local timezone='UTC';
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001')||'{"capacity":10}')$q$,'23505','request_reused');
select session_test.expect_error($q$select public.court_allocation_block('c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000099',session_test.at(630),session_test.at(690))$q$,'23P01','allocation_conflict');
select session_test.expect_error($q$select public.rental_booking_request('c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000098',session_test.at(630),session_test.at(690),
  public.rental_booking_quote('c1000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000002',session_test.at(630),session_test.at(690))->'expected_quote')$q$,'23P01','allocation_conflict');
select session_test.expect_error($q$select public.court_hours_save('c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000001',null,'{"weekly":[[],[],[],[],[],[],[]],"closures":[]}')$q$,'55006','hours_conflict');
reset role;
select session_test.assert_that((select count(*)=2 from private.session_courts),'two courts');
select session_test.assert_that((select count(*)=1 from private.directory_audit_events where action='session.create'),'one audit');
select session_test.expect_error($q$update private.open_play_sessions set snapshot='{}'$q$,'55000','immutable_session');
select session_test.expect_error($q$update public.courts set status='inactive' where id='c3000000-0000-4000-8000-000000000001'$q$,'55006','court_allocated');
-- Last-court conflict rolls back the first court allocation and session, including expired-hold cleanup.
select private.allocation_acquire('c3000000-0000-4000-8000-000000000002','rental',session_test.at(900),session_test.at(960),null,
  'c1000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000010');
set local role service_role;
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000002',null,900,960))$q$,'23P01','allocation_conflict');
reset role;
select session_test.assert_that((select count(*)=0 from private.court_allocations where court_id='c3000000-0000-4000-8000-000000000001' and starts_at=session_test.at(900)),'atomic multi-court rollback');
select session_test.assert_that((select count(*)=1 from private.open_play_sessions),'no partial session');
-- A selected court closed on the next Manila day rejects the entire overnight/day-three session.
select public.court_hours_save('c1000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000002',null,
  jsonb_build_object('weekly',null,'closures',jsonb_build_array(to_char((now() at time zone 'Asia/Manila')::date+3,'YYYY-MM-DD'))));
set local role service_role;
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000020',null,1980,2040))$q$,'23514','outside_hours');
reset role;
select session_test.assert_that((select count(*)=1 from private.open_play_sessions),'closed-court creation rolls back');
-- Snapshot does not follow later policy changes.
select public.owner_venue_policy_save('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','0','{"confirmation":"approval","payment":"arrival"}');
select session_test.assert_that((select snapshot->'policy'->>'confirmation'='instant' and snapshot->>'price_centavos'='25000' from private.open_play_sessions),'immutable original policy and price');
-- Cancellation cannot release a session with participants; no generic block release can bypass it.
update private.open_play_sessions set reserved_spots=1;
select session_test.expect_error($q$select session_test.cancel('c4000000-0000-4000-8000-000000000001')$q$,'55000','session_has_bookings');
select session_test.expect_error($q$select public.court_allocation_release('c1000000-0000-4000-8000-000000000001',(select allocation_id from private.session_courts limit 1))$q$,'42501','managed_allocation');
update private.open_play_sessions set reserved_spots=0;
-- Audit failure rolls back cancellation and court releases.
create function session_test.fail_audit() returns trigger language plpgsql as $$ begin if new.action in ('session.cancel','session.create') then raise exception 'audit failure'; end if; return new; end; $$;
create trigger session_fail_audit before insert on private.directory_audit_events for each row execute function session_test.fail_audit();
select session_test.expect_error($q$select session_test.cancel('c4000000-0000-4000-8000-000000000001')$q$,'P0001');
select session_test.assert_that((select count(*)=2 from private.court_allocations where kind='session' and state='active'),'cancel audit rollback');
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000003',null,780,840))$q$,'P0001');
select session_test.assert_that((select count(*)=1 from private.open_play_sessions),'create audit rollback');
drop trigger session_fail_audit on private.directory_audit_events;
-- Suspension stops new creation, while historical reads and empty cancellation remain usable.
update public.venues set publication_status='suspended' where id='c2000000-0000-4000-8000-000000000001';
set local role service_role;
select session_test.expect_error($q$select session_test.create(session_test.input('c4000000-0000-4000-8000-000000000003',null,780,840))$q$,'P0002','venue_unavailable');
select session_test.assert_that(jsonb_array_length(public.owner_session_read('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001')->'sessions')=1,'owner read under suspension');
select session_test.assert_that(session_test.cancel('c4000000-0000-4000-8000-000000000001')->>'outcome'='cancelled','cancelled');
select session_test.assert_that(session_test.cancel('c4000000-0000-4000-8000-000000000001')->>'outcome'='existing','cancel retry');
select session_test.assert_that(session_test.create(session_test.input('c4000000-0000-4000-8000-000000000001'))->'session'->>'status'='cancelled','retry never revives');
reset role;
select session_test.assert_that((select count(*)=2 from private.court_allocations where kind='session' and state='released'),'all courts released');
select session_test.assert_that((select count(*)=1 from private.directory_audit_events where action='session.cancel'),'one cancellation audit');
insert into private.open_play_sessions(id,venue_id,created_by,request_id,request_input,snapshot,starts_at,ends_at,capacity)
  values('c5000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000030','{}','{}',session_test.at(600)-interval '3 days',session_test.at(660)-interval '3 days',1);
select session_test.expect_error($q$select public.owner_session_cancel('c1000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001')$q$,'55000','session_started');
delete from private.venue_owners where venue_id='c2000000-0000-4000-8000-000000000001';
select session_test.expect_error($q$select public.owner_session_read('c1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001')$q$,'42501','not_owner');
rollback;
