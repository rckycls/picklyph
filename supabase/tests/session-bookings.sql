-- Rollback-only T28 fixtures, relative to the database clock.
begin;
create schema group_test;
create function group_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Group booking assertion failed: %',message; end if; end; $$;
create function group_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function group_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function group_test.session(request text,court text,a integer,b integer,capacity integer,lim integer,price integer) returns uuid language sql as $$
select (public.owner_session_create('c7100000-0000-4000-8000-000000000001',jsonb_build_object('venue_id','c7200000-0000-4000-8000-000000000001',
  'request_id',request,'court_ids',jsonb_build_array(court),'title','Group play','starts_at',group_test.at(a),'ends_at',group_test.at(b),
  'capacity',capacity,'group_limit',lim,'price_centavos',price))->'session'->>'id')::uuid; $$;
create function group_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=request::uuid; $$;
create function group_test.bid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=request::uuid; $$;
create function group_test.req(actor text,session_request text,request text,names jsonb,total bigint) returns jsonb language sql as $$
select public.session_booking_request(('c7100000-0000-4000-8000-00000000000'||actor)::uuid,jsonb_build_object('session_id',group_test.sid(session_request),
  'request_id',request,'participants',names,'expected_total_centavos',total)); $$;
create function group_test.change(actor text,request text,command text) returns jsonb language sql as $$
select public.session_booking_change(('c7100000-0000-4000-8000-00000000000'||actor)::uuid,group_test.bid(request),command); $$;
create function group_test.reserved(session_request text) returns integer language sql security definer set search_path='' as $$
select reserved_spots from private.open_play_sessions where request_id=session_request::uuid; $$;
create function group_test.events(request text) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select e.action,count(*) n from private.session_booking_events e
  join private.session_bookings b on b.id=e.booking_id where b.request_id=request::uuid group by e.action) x; $$;
-- Trusted SQL only: stand in for operator policy/merchant state and an elapsed hold.
create function group_test.policy(text,text,boolean) returns void language sql security definer as $$
insert into private.venue_merchants(venue_id,active) values('c7200000-0000-4000-8000-000000000001',$3)
  on conflict (venue_id) do update set active=excluded.active;
insert into private.venue_policies(venue_id,confirmation,payment) values('c7200000-0000-4000-8000-000000000001',$1,$2)
  on conflict (venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=private.venue_policies.revision+1; $$;
create function group_test.elapse(request text) returns void language plpgsql security definer as $$
begin
  alter table private.session_bookings disable trigger session_booking_guard;
  update private.session_bookings set expires_at=clock_timestamp()-interval '1 second' where request_id=request::uuid;
  alter table private.session_bookings enable trigger session_booking_guard;
end; $$;
grant usage on schema group_test to anon,authenticated,service_role;
grant execute on all functions in schema group_test to anon,authenticated,service_role;
insert into auth.users(id) values ('c7100000-0000-4000-8000-000000000001'),('c7100000-0000-4000-8000-000000000002'),
  ('c7100000-0000-4000-8000-000000000003'),('c7100000-0000-4000-8000-000000000004'),('c7100000-0000-4000-8000-000000000005'),
  ('c7100000-0000-4000-8000-000000000006');
insert into private.account_roles(user_id,role) values ('c7100000-0000-4000-8000-000000000006','admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('c7200000-0000-4000-8000-000000000001','Group Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) values
  ('c7300000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001','A','active'),
  ('c7300000-0000-4000-8000-000000000002','c7200000-0000-4000-8000-000000000001','B','active');
insert into private.venue_owners(user_id,venue_id) values ('c7100000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001');
select public.venue_schedule_save('c7100000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
-- Instant session: 8 spots, groups of 4, ₱250/person. Approval: 3 spots. Online-only (merchant active) and a later approval session.
select group_test.session('c7400000-0000-4000-8000-000000000001','c7300000-0000-4000-8000-000000000001',600,720,8,4,25000);
select group_test.policy('approval','arrival',false);
select group_test.session('c7400000-0000-4000-8000-000000000002','c7300000-0000-4000-8000-000000000002',600,720,3,3,30000);
select group_test.session('c7400000-0000-4000-8000-000000000004','c7300000-0000-4000-8000-000000000002',900,960,4,4,0);
select group_test.policy('instant','online',true);
select group_test.session('c7400000-0000-4000-8000-000000000003','c7300000-0000-4000-8000-000000000001',780,840,4,4,25000);
select group_test.policy('instant','arrival',false);
insert into private.open_play_sessions(venue_id,created_by,request_id,request_input,snapshot,starts_at,ends_at,capacity)
  select venue_id,created_by,'c7400000-0000-4000-8000-000000000009','{}',snapshot,group_test.at(600)-interval '3 days',group_test.at(660)-interval '3 days',6
  from private.open_play_sessions where request_id='c7400000-0000-4000-8000-000000000001';

-- API roles reach nothing directly; service role reaches only the public wrappers.
set local role anon;
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'42501');
reset role;
set local role authenticated;
select group_test.expect_error($q$select public.session_booking_read('c7100000-0000-4000-8000-000000000002','history')$q$,'42501');
select group_test.expect_error($q$select * from private.session_bookings$q$,'42501');
reset role;
set local role service_role;
select group_test.expect_error($q$select * from private.session_booking_events$q$,'42501');
select group_test.expect_error($q$select private.session_expire_holds(null,now())$q$,'42501');
select group_test.expect_error($q$select private.session_booking_json(null,now())$q$,'42501');
select group_test.expect_error($q$select public.session_booking_request('c7100000-0000-4000-8000-000000000009','{}')$q$,'42501','player_required');
select group_test.expect_error(format($q$select public.session_booking_request('c7100000-0000-4000-8000-000000000002',jsonb_build_object(
  'session_id',group_test.sid('c7400000-0000-4000-8000-000000000001'),'request_id','c7500000-0000-4000-8000-000000000001',
  'participants','["Ana","Ben"]'::jsonb,'expected_total_centavos',50000)||%L::jsonb)$q$,bad),'22023','invalid_input')
  from unnest(array['{"actor_user_id":"x"}','{"spots":2}','{"participants":[]}','{"participants":["Ana","ana"]}','{"participants":["  "]}',
    '{"participants":["Ana\nB"]}','{"participants":[1]}','{"participants":"Ana"}','{"expected_total_centavos":-1}','{"expected_total_centavos":0.5}',
    '{"expected_total_centavos":"50000"}','{"request_id":"nope"}',
    format('{"participants":["%s"]}',repeat('a',61))]) bad;
select group_test.expect_error($q$select public.session_booking_request('c7100000-0000-4000-8000-000000000002',jsonb_build_object('session_id',gen_random_uuid(),
  'request_id','c7500000-0000-4000-8000-000000000001','participants','["Ana"]'::jsonb,'expected_total_centavos',25000))$q$,'P0002','session_not_found');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["A","B","C","D","E"]',125000)$q$,'23514','group_limit_exceeded');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["Ana","Ben"]',25000)$q$,'40001','stale_quote');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000003','c7500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'23514','arrival_unavailable');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000009','c7500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'55000','session_started');
-- Instant arrival group: confirmed, trimmed ordered names, exact total, one event.
select group_test.assert_that((select r->>'outcome'='created' and r->'booking'->>'status'='confirmed' and r->'booking'->'expires_at'='null'::jsonb
    and r->'booking'->'participants'='["Ana","Ben"]'::jsonb and (r->'booking'->'snapshot'->>'total_centavos')::bigint=50000
    and r->'booking'->>'payment_status'='unpaid' and r->'booking'->'snapshot'->>'venue_id'='c7200000-0000-4000-8000-000000000001'
  from group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','[" Ana ","Ben"]',50000) r),'instant created');
select group_test.assert_that(group_test.reserved('c7400000-0000-4000-8000-000000000001')=2,'two spots');
select group_test.assert_that(group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["Ana","Ben"]',50000)->>'outcome'='existing','canonical retry');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["Ana","Cy"]',50000)$q$,'23505','request_reused');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000001','["Ana","Ben"]',60000)$q$,'23505','request_reused');
select group_test.expect_error($q$select group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000002','["Cy"]',25000)$q$,'23505','already_booked');
select group_test.assert_that(group_test.req('3','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000003','["Di","Ed","Fe","Gi"]',100000)->>'outcome'='created','second group');
select group_test.expect_error($q$select group_test.req('4','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000004','["Hu","Ix","Jo"]',75000)$q$,'23514','session_full');
select group_test.assert_that(group_test.reserved('c7400000-0000-4000-8000-000000000001')=6 and group_test.events('c7500000-0000-4000-8000-000000000001')='{"request":1}','oversell refused, one event');
-- Only the booking player cancels; repeated cancellation releases once and the spot is resold.
select group_test.expect_error($q$select group_test.change('3','c7500000-0000-4000-8000-000000000001','cancel')$q$,'42501','not_player');
select group_test.expect_error($q$select group_test.change('1','c7500000-0000-4000-8000-000000000001','cancel')$q$,'42501','not_player');
select group_test.expect_error($q$select group_test.change('2','c7500000-0000-4000-8000-000000000001','accept')$q$,'42501','not_owner');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000001','accept')->>'outcome'='existing','instant accept is idempotent');
select group_test.expect_error($q$select group_test.change('1','c7500000-0000-4000-8000-000000000001','decline')$q$,'23514','invalid_transition');
select group_test.assert_that(group_test.change('2','c7500000-0000-4000-8000-000000000001','cancel')->>'outcome'='changed','cancelled');
select group_test.assert_that(group_test.change('2','c7500000-0000-4000-8000-000000000001','cancel')->>'outcome'='existing','cancel retry');
select group_test.assert_that(group_test.reserved('c7400000-0000-4000-8000-000000000001')=4 and group_test.events('c7500000-0000-4000-8000-000000000001')='{"cancel":1,"request":1}','released once');
select group_test.assert_that(group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000001','["Ana","Ben"]',50000)->'booking'->>'status'='cancelled','retry never revives');
select group_test.assert_that(group_test.req('2','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000005','["Ana","Ben"]',50000)->>'outcome'='created','rebook after cancel');
-- Approval group: hold capped at two hours, owner accept is firm; admins alone cannot decide.
select group_test.assert_that((select r->'booking'->>'status'='pending' and (r->'booking'->>'expires_at')::timestamptz between clock_timestamp()+interval '119 minutes' and clock_timestamp()+interval '2 hours'
  from group_test.req('2','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000010','["Ana"]',30000) r),'approval hold');
select group_test.assert_that(group_test.req('3','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000011','["Di"]',30000)->'booking'->>'status'='pending','second hold');
select group_test.expect_error($q$select group_test.change('6','c7500000-0000-4000-8000-000000000010','accept')$q$,'42501','not_owner');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000010','accept')->'booking'->>'status'='confirmed','accepted');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000010','accept')->>'outcome'='existing','accept retry');
select group_test.expect_error($q$select group_test.change('1','c7500000-0000-4000-8000-000000000010','decline')$q$,'23514','invalid_transition');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000011','decline')->'booking'->>'status'='declined','declined');
select group_test.assert_that(group_test.reserved('c7400000-0000-4000-8000-000000000002')=1,'decline released one spot');
-- Elapsed hold: reads report it expired/free before any write; the next request releases it once (system event).
select group_test.assert_that(group_test.req('4','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000012','["Hu","Ix"]',60000)->'booking'->>'status'='pending','filling hold');
select group_test.elapse('c7500000-0000-4000-8000-000000000012');
reset role;
select group_test.assert_that((select public.session_booking_read('c7100000-0000-4000-8000-000000000004','booking',group_test.bid('c7500000-0000-4000-8000-000000000012'))->'booking'->>'status'='expired'),'reads expired');
select group_test.assert_that((select (public.session_booking_read('c7100000-0000-4000-8000-000000000005','session',group_test.sid('c7400000-0000-4000-8000-000000000002'))->'session'->>'available_spots')::integer=2),'elapsed hold is free');
select group_test.assert_that((select (public.owner_session_read('c7100000-0000-4000-8000-000000000001','c7200000-0000-4000-8000-000000000001')->'sessions') @> jsonb_build_array(jsonb_build_object('id',group_test.sid('c7400000-0000-4000-8000-000000000002'),'reserved_spots',1))),'owner effective count');
select group_test.assert_that((select count(*)=1 from private.session_bookings where status='pending'),'still stored pending');
set local role service_role;
select group_test.assert_that(group_test.req('5','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000013','["Jo","Ka"]',60000)->'booking'->>'status'='pending','resold elapsed spots');
select group_test.assert_that(group_test.events('c7500000-0000-4000-8000-000000000012')='{"expire":1,"request":1}','one expire event');
select group_test.expect_error($q$select group_test.change('1','c7500000-0000-4000-8000-000000000012','accept')$q$,'23514','invalid_transition');
select group_test.assert_that(group_test.req('4','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000012','["Hu","Ix"]',60000)->'booking'->>'status'='expired','expired retry never revives');
-- Acceptance of an unswept elapsed hold expires it instead; empty-session cancellation sweeps first.
select group_test.elapse('c7500000-0000-4000-8000-000000000013');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000013','accept')->>'outcome'='expired','accept cannot revive');
select group_test.assert_that(group_test.events('c7500000-0000-4000-8000-000000000013')='{"expire":1,"request":1}' and group_test.reserved('c7400000-0000-4000-8000-000000000002')=1,'expire once');
select group_test.assert_that(group_test.req('2','c7400000-0000-4000-8000-000000000004','c7500000-0000-4000-8000-000000000014','["Ana"]',0)->'booking'->'snapshot'->>'total_centavos'='0','free session hold');
select group_test.expect_error($q$select public.owner_session_cancel('c7100000-0000-4000-8000-000000000001',group_test.sid('c7400000-0000-4000-8000-000000000004'))$q$,'55000','session_has_bookings');
select group_test.elapse('c7500000-0000-4000-8000-000000000014');
select group_test.assert_that(public.owner_session_cancel('c7100000-0000-4000-8000-000000000001',group_test.sid('c7400000-0000-4000-8000-000000000004'))->>'outcome'='cancelled','cancel after elapsed hold');
select group_test.expect_error($q$select group_test.req('3','c7400000-0000-4000-8000-000000000004','c7500000-0000-4000-8000-000000000015','["Di"]',0)$q$,'55000','session_cancelled');
-- Original session price/policy snapshot governs later groups.
select group_test.policy('approval','arrival',false);
select group_test.assert_that(group_test.req('4','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000016','["Hu"]',25000)->'booking'->>'status'='confirmed','session policy governs');
reset role;
select group_test.expect_error($q$update private.session_bookings set participants='["X"]' where request_id='c7500000-0000-4000-8000-000000000016'$q$,'55000','immutable_booking');
select group_test.expect_error($q$update private.session_bookings set status='pending' where request_id='c7500000-0000-4000-8000-000000000001'$q$,'55000','immutable_booking');
select group_test.expect_error($q$update private.session_booking_events set action='cancel'$q$,'23514','immutable_snapshot');
-- Event failure rolls back the booking and its spots.
create function group_test.fail_event() returns trigger language plpgsql as $$ begin if new.action in ('request','cancel') then raise exception 'event failure'; end if; return new; end; $$;
create trigger group_fail_event before insert on private.session_booking_events for each row execute function group_test.fail_event();
select group_test.expect_error($q$select group_test.req('5','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000017','["Jo"]',25000)$q$,'P0001');
select group_test.expect_error($q$select group_test.change('4','c7500000-0000-4000-8000-000000000016','cancel')$q$,'P0001');
select group_test.assert_that(group_test.reserved('c7400000-0000-4000-8000-000000000001')=7 and group_test.bid('c7500000-0000-4000-8000-000000000017') is null,'event rollback');
drop trigger group_fail_event on private.session_booking_events;
-- Reads: offers by start time without names; self history; owner live requests only.
select group_test.assert_that((select jsonb_array_length(r->'sessions')=3 and r->'sessions'->2->>'id'=group_test.sid('c7400000-0000-4000-8000-000000000003')::text
    and r::text not like '%Ana%' and r::text not like '%revision%' and jsonb_path_query_first(r->'sessions','$[*] ? (@.id == $id)',
      jsonb_build_object('id',group_test.sid('c7400000-0000-4000-8000-000000000001')))->>'available_spots'='1'
  from public.session_booking_read('c7100000-0000-4000-8000-000000000005','sessions','c7200000-0000-4000-8000-000000000001') r),'offers');
select group_test.assert_that(jsonb_array_length(public.session_booking_read('c7100000-0000-4000-8000-000000000002','history')->'bookings')=4,'own history');
select group_test.assert_that(jsonb_array_length(public.session_booking_read('c7100000-0000-4000-8000-000000000001','requests','c7200000-0000-4000-8000-000000000001')->'bookings')=0,'no live requests');
select group_test.expect_error($q$select public.session_booking_read('c7100000-0000-4000-8000-000000000003','booking',group_test.bid('c7500000-0000-4000-8000-000000000001'))$q$,'42501','not_owner');
select group_test.expect_error($q$select public.session_booking_read('c7100000-0000-4000-8000-000000000002','requests','c7200000-0000-4000-8000-000000000001')$q$,'42501','not_owner');
select group_test.assert_that(public.session_booking_read('c7100000-0000-4000-8000-000000000001','booking',group_test.bid('c7500000-0000-4000-8000-000000000001'))->'booking'->'participants'='["Ana","Ben"]','owner sees names');
-- Suspension stops new groups/acceptance but keeps release and reads; revocation removes owner access only.
select group_test.assert_that(group_test.req('5','c7400000-0000-4000-8000-000000000002','c7500000-0000-4000-8000-000000000018','["Jo"]',30000)->'booking'->>'status'='pending','pending before suspension');
update public.venues set publication_status='suspended' where id='c7200000-0000-4000-8000-000000000001';
select group_test.expect_error($q$select group_test.req('3','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000019','["Di"]',25000)$q$,'P0002','venue_unavailable');
select group_test.expect_error($q$select group_test.change('1','c7500000-0000-4000-8000-000000000018','accept')$q$,'P0002','venue_unavailable');
select group_test.expect_error($q$select public.session_booking_read('c7100000-0000-4000-8000-000000000005','sessions','c7200000-0000-4000-8000-000000000001')$q$,'P0002','venue_unavailable');
select group_test.assert_that(group_test.change('1','c7500000-0000-4000-8000-000000000018','decline')->'booking'->>'status'='declined','decline under suspension');
select group_test.assert_that(group_test.change('4','c7500000-0000-4000-8000-000000000016','cancel')->'booking'->>'status'='cancelled','cancel under suspension');
update public.venues set publication_status='approved' where id='c7200000-0000-4000-8000-000000000001';
delete from private.venue_owners where venue_id='c7200000-0000-4000-8000-000000000001';
select group_test.expect_error($q$select group_test.req('3','c7400000-0000-4000-8000-000000000001','c7500000-0000-4000-8000-000000000019','["Di"]',25000)$q$,'P0002','venue_unavailable');
select group_test.expect_error($q$select public.session_booking_read('c7100000-0000-4000-8000-000000000001','booking',group_test.bid('c7500000-0000-4000-8000-000000000003'))$q$,'42501','not_owner');
select group_test.assert_that(group_test.change('3','c7500000-0000-4000-8000-000000000003','cancel')->>'outcome'='changed','player cancel after revocation');
-- The stored counter equals live spots for every session.
select group_test.assert_that(not exists(select 1 from private.open_play_sessions s where s.reserved_spots<>coalesce((select sum(b.spots)
  from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)),'counter invariant');
rollback;
