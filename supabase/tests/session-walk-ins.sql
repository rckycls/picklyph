-- Rollback-only T29 fixtures, relative to the database clock.
begin;
create schema walk_test;
create function walk_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Walk-in assertion failed: %',message; end if; end; $$;
create function walk_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function walk_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function walk_test.u(n text) returns uuid language sql immutable as $$ select ('c8100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function walk_test.session(request text,court text,a integer,b integer,capacity integer,lim integer) returns uuid language sql as $$
select (public.owner_session_create(walk_test.u('1'),jsonb_build_object('venue_id','c8200000-0000-4000-8000-000000000001',
  'request_id',request,'court_ids',jsonb_build_array(court),'title','Walk-in play','starts_at',walk_test.at(a),'ends_at',walk_test.at(b),
  'capacity',capacity,'group_limit',lim,'price_centavos',25000))->'session'->>'id')::uuid; $$;
create function walk_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=request::uuid; $$;
create function walk_test.bid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=request::uuid; $$;
create function walk_test.walk(actor text,session_request text,request text,names jsonb,total bigint) returns jsonb language sql as $$
select public.session_walk_in(walk_test.u(actor),jsonb_build_object('session_id',walk_test.sid(session_request),
  'request_id',request,'participants',names,'expected_total_centavos',total)); $$;
create function walk_test.req(actor text,session_request text,request text,names jsonb,total bigint) returns jsonb language sql as $$
select public.session_booking_request(walk_test.u(actor),jsonb_build_object('session_id',walk_test.sid(session_request),
  'request_id',request,'participants',names,'expected_total_centavos',total)); $$;
create function walk_test.change(actor text,request text,command text) returns jsonb language sql as $$
select public.session_booking_change(walk_test.u(actor),walk_test.bid(request),command); $$;
create function walk_test.reserved(session_request text) returns integer language sql security definer set search_path='' as $$
select reserved_spots from private.open_play_sessions where request_id=session_request::uuid; $$;
create function walk_test.events(request text) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select e.action,count(*) n from private.session_booking_events e
  join private.session_bookings b on b.id=e.booking_id where b.request_id=request::uuid group by e.action) x; $$;
-- Trusted SQL only: stand in for operator policy/merchant state and an elapsed hold.
create function walk_test.policy(text,text,boolean) returns void language sql security definer as $$
insert into private.venue_merchants(venue_id,active) values('c8200000-0000-4000-8000-000000000001',$3)
  on conflict (venue_id) do update set active=excluded.active;
insert into private.venue_policies(venue_id,confirmation,payment) values('c8200000-0000-4000-8000-000000000001',$1,$2)
  on conflict (venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=private.venue_policies.revision+1; $$;
create function walk_test.elapse(request text) returns void language plpgsql security definer as $$
begin
  alter table private.session_bookings disable trigger session_booking_guard;
  update private.session_bookings set expires_at=clock_timestamp()-interval '1 second' where request_id=request::uuid;
  alter table private.session_bookings enable trigger session_booking_guard;
end; $$;
grant usage on schema walk_test to anon,authenticated,service_role;
grant execute on all functions in schema walk_test to anon,authenticated,service_role;
insert into auth.users(id) select walk_test.u(n::text) from generate_series(1,6) n;
insert into private.account_roles(user_id,role) values (walk_test.u('6'),'admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('c8200000-0000-4000-8000-000000000001','Walk-in Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) values
  ('c8300000-0000-4000-8000-000000000001','c8200000-0000-4000-8000-000000000001','A','active'),
  ('c8300000-0000-4000-8000-000000000002','c8200000-0000-4000-8000-000000000001','B','active');
insert into private.venue_owners(user_id,venue_id) values (walk_test.u('1'),'c8200000-0000-4000-8000-000000000001');
select public.venue_schedule_save(walk_test.u('1'),'c8200000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
-- Instant arrival sessions (8 and 6 spots, groups of 4, ₱250/person), a soon-cancelled one, online-only and approval sessions.
select walk_test.session('c8400000-0000-4000-8000-000000000001','c8300000-0000-4000-8000-000000000001',600,720,8,4);
select walk_test.session('c8400000-0000-4000-8000-000000000005','c8300000-0000-4000-8000-000000000002',600,720,6,4);
select walk_test.session('c8400000-0000-4000-8000-000000000007','c8300000-0000-4000-8000-000000000001',900,960,4,4);
select walk_test.policy('instant','online',true);
select walk_test.session('c8400000-0000-4000-8000-000000000002','c8300000-0000-4000-8000-000000000001',780,840,4,4);
select walk_test.policy('approval','arrival',false);
select walk_test.session('c8400000-0000-4000-8000-000000000006','c8300000-0000-4000-8000-000000000002',780,840,2,2);
select walk_test.policy('instant','arrival',false);
-- Trusted SQL: one session in progress and one already ended (no court allocations needed for spot inventory).
insert into private.open_play_sessions(venue_id,created_by,request_id,request_input,snapshot,starts_at,ends_at,capacity)
  select venue_id,created_by,x.r::uuid,'{}',snapshot,to_timestamp(floor(extract(epoch from now())/1800)*1800)+x.a,
    to_timestamp(floor(extract(epoch from now())/1800)*1800)+x.b,6
  from private.open_play_sessions cross join (values ('c8400000-0000-4000-8000-000000000003',interval '-30 minutes',interval '2 hours'),
    ('c8400000-0000-4000-8000-000000000004',interval '-3 hours',interval '-1 hour')) x(r,a,b)
  where request_id='c8400000-0000-4000-8000-000000000001';
select public.owner_session_cancel(walk_test.u('1'),walk_test.sid('c8400000-0000-4000-8000-000000000007'));

-- API roles reach nothing directly; service role reaches only the public wrapper.
set local role anon;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'42501');
reset role;
set local role authenticated;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'42501');
reset role;
set local role service_role;
select walk_test.expect_error($q$select private.session_group_input('{}')$q$,'42501');
-- Only a current owner of the session's venue: players, admins and unknown accounts are refused.
select walk_test.expect_error(format($q$select walk_test.walk(%L,'c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,n),'42501','not_owner')
  from unnest(array['2','6','9']) n;
select walk_test.expect_error(format($q$select public.session_walk_in(walk_test.u('1'),jsonb_build_object(
  'session_id',walk_test.sid('c8400000-0000-4000-8000-000000000001'),'request_id','c8500000-0000-4000-8000-000000000001',
  'participants','["Ana","Ben"]'::jsonb,'expected_total_centavos',50000)||%L::jsonb)$q$,bad),'22023','invalid_input')
  from unnest(array['{"kind":"walk_in"}','{"source":"walk_in"}','{"participants":[]}','{"participants":["Ana","ANA"]}','{"participants":[" "]}',
    '{"participants":["Ana\tB"]}','{"expected_total_centavos":-1}','{"request_id":"nope"}',format('{"participants":["%s"]}',repeat('a',61))]) bad;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["A","B","C","D","E"]',125000)$q$,'23514','group_limit_exceeded');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana","Ben"]',25000)$q$,'40001','stale_quote');
select walk_test.expect_error($q$select public.session_walk_in(walk_test.u('1'),jsonb_build_object('session_id',gen_random_uuid(),
  'request_id','c8500000-0000-4000-8000-000000000001','participants','["Ana"]'::jsonb,'expected_total_centavos',25000))$q$,'P0002','session_not_found');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000007','c8500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'55000','session_cancelled');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000004','c8500000-0000-4000-8000-000000000001','["Ana"]',25000)$q$,'55000','session_ended');
-- A walk-in is a confirmed, unpaid arrival group with trimmed ordered names, an exact total and one event.
select walk_test.assert_that((select r->>'outcome'='created' and b->>'source'='walk_in' and b->>'status'='confirmed' and b->'expires_at'='null'::jsonb
    and b->'participants'='["Ana","Ben","Cy"]'::jsonb and (b->'snapshot'->>'total_centavos')::bigint=75000 and b->>'payment_method'='arrival'
    and b->>'payment_status'='unpaid' and b->'snapshot'->>'venue_id'='c8200000-0000-4000-8000-000000000001'
  from walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','[" Ana ","Ben","Cy"]',75000) r,
    lateral (select r->'booking' b) x),'walk-in created');
select walk_test.assert_that(walk_test.reserved('c8400000-0000-4000-8000-000000000001')=3
  and walk_test.events('c8500000-0000-4000-8000-000000000001')='{"walk_in":1}','three spots, one event');
-- Retries: the same key returns the original; changed input or the same key as a player request is refused.
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana","Ben","Cy"]',75000)->>'outcome'='existing','canonical retry');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana","Ben"]',50000)$q$,'23505','request_reused');
select walk_test.expect_error($q$select walk_test.req('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana","Ben","Cy"]',75000)$q$,'23505','request_reused');
select walk_test.assert_that(walk_test.reserved('c8400000-0000-4000-8000-000000000001')=3 and walk_test.events('c8500000-0000-4000-8000-000000000001')='{"walk_in":1}','retries add nothing');
-- Walk-ins and player groups share one capacity; owners may enter several walk-in groups.
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000002','["Di","Ed","Fe","Gi"]',100000)->>'outcome'='created','second walk-in group');
select walk_test.expect_error($q$select walk_test.req('2','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000003','["Hu","Ix"]',50000)$q$,'23514','session_full');
select walk_test.assert_that(walk_test.req('2','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000003','["Hu"]',25000)->'booking'->>'source'='player','player takes the last spot');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000004','["Jo"]',25000)$q$,'23514','session_full');
select walk_test.assert_that(walk_test.reserved('c8400000-0000-4000-8000-000000000001')=8 and walk_test.bid('c8500000-0000-4000-8000-000000000004') is null,'never oversold');
select walk_test.assert_that((select (public.session_booking_read(walk_test.u('3'),'session',walk_test.sid('c8400000-0000-4000-8000-000000000001'))->'session'->>'available_spots')::integer=0),'offers count walk-ins');
-- Entering walk-ins does not stop the owner booking their own player group; player history excludes walk-ins.
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000005','c8500000-0000-4000-8000-000000000005','["Ka"]',25000)->>'outcome'='created','walk-in in second session');
select walk_test.assert_that(walk_test.req('1','c8400000-0000-4000-8000-000000000005','c8500000-0000-4000-8000-000000000006','["Owner"]',25000)->>'outcome'='created','owner as player');
select walk_test.assert_that((select jsonb_array_length(r->'bookings')=1 and r->'bookings'->0->>'source'='player'
  from public.session_booking_read(walk_test.u('1'),'history') r),'history excludes walk-ins');
-- Walk-ins pay at the venue even when players must pay online, and may join a session already in progress.
select walk_test.expect_error($q$select walk_test.req('2','c8400000-0000-4000-8000-000000000002','c8500000-0000-4000-8000-000000000007','["Hu"]',25000)$q$,'23514','arrival_unavailable');
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000002','c8500000-0000-4000-8000-000000000008','["Lu"]',25000)->'booking'->>'payment_method'='arrival','online-only walk-in');
select walk_test.expect_error($q$select walk_test.req('2','c8400000-0000-4000-8000-000000000003','c8500000-0000-4000-8000-000000000009','["Hu"]',25000)$q$,'55000','session_started');
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000003','c8500000-0000-4000-8000-000000000010','["Mo","Ni"]',50000)->>'outcome'='created','walk-in after start');
-- Elapsed player holds release before a walk-in claims their spots (one system expiry).
select walk_test.assert_that(walk_test.req('3','c8400000-0000-4000-8000-000000000006','c8500000-0000-4000-8000-000000000011','["Ox","Pa"]',50000)->'booking'->>'status'='pending','full approval hold');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000006','c8500000-0000-4000-8000-000000000012','["Qi"]',25000)$q$,'23514','session_full');
select walk_test.elapse('c8500000-0000-4000-8000-000000000011');
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000006','c8500000-0000-4000-8000-000000000012','["Qi","Ro"]',50000)->'booking'->>'status'='confirmed','walk-in resells elapsed hold');
select walk_test.assert_that(walk_test.events('c8500000-0000-4000-8000-000000000011')='{"expire":1,"request":1}' and walk_test.reserved('c8400000-0000-4000-8000-000000000006')=2,'expired once');
-- Removal: any current owner, never the player or an admin; once, until the session ends; retries never revive.
reset role;
insert into private.venue_owners(user_id,venue_id) values (walk_test.u('5'),'c8200000-0000-4000-8000-000000000001');
set local role service_role;
select walk_test.expect_error(format($q$select walk_test.change(%L,'c8500000-0000-4000-8000-000000000001','cancel')$q$,n),'42501','not_owner') from unnest(array['2','6']) n;
select walk_test.expect_error($q$select walk_test.change('1','c8500000-0000-4000-8000-000000000001','decline')$q$,'23514','invalid_transition');
select walk_test.assert_that(walk_test.change('1','c8500000-0000-4000-8000-000000000001','accept')->>'outcome'='existing','accepting a walk-in changes nothing');
select walk_test.assert_that(walk_test.change('5','c8500000-0000-4000-8000-000000000001','cancel')->'booking'->>'status'='cancelled','co-owner removes walk-in');
select walk_test.assert_that(walk_test.change('1','c8500000-0000-4000-8000-000000000001','cancel')->>'outcome'='existing','removal retry');
select walk_test.assert_that(walk_test.reserved('c8400000-0000-4000-8000-000000000001')=5
  and walk_test.events('c8500000-0000-4000-8000-000000000001')='{"cancel":1,"walk_in":1}','released once');
select walk_test.assert_that(walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000001','["Ana","Ben","Cy"]',75000)->'booking'->>'status'='cancelled','retry never revives');
select walk_test.assert_that(walk_test.change('5','c8500000-0000-4000-8000-000000000010','cancel')->>'outcome'='changed','remove after start');
-- Live walk-ins keep the T27 empty-session cancellation closed.
select walk_test.expect_error($q$select public.owner_session_cancel(walk_test.u('1'),walk_test.sid('c8400000-0000-4000-8000-000000000002'))$q$,'55000','session_has_bookings');
-- Reads: owners list a session's walk-ins with names; players and admins cannot read them.
select walk_test.assert_that((select jsonb_array_length(r->'bookings')=2 and r::text like '%Ana%' and r::text like '%Gi%'
    and not exists(select 1 from jsonb_array_elements(r->'bookings') x where x->>'source'<>'walk_in')
  from public.session_booking_read(walk_test.u('5'),'walk_ins',walk_test.sid('c8400000-0000-4000-8000-000000000001')) r),'walk-in roster');
select walk_test.expect_error(format($q$select public.session_booking_read(walk_test.u(%L),'walk_ins',walk_test.sid('c8400000-0000-4000-8000-000000000001'))$q$,n),'42501','not_owner')
  from unnest(array['2','6']) n;
select walk_test.expect_error($q$select public.session_booking_read(walk_test.u('1'),'walk_ins',gen_random_uuid())$q$,'P0002','session_not_found');
select walk_test.expect_error($q$select public.session_booking_read(walk_test.u('1'),'walk_ins')$q$,'22023','invalid_input');
select walk_test.expect_error($q$select public.session_booking_read(walk_test.u('2'),'booking',walk_test.bid('c8500000-0000-4000-8000-000000000002'))$q$,'42501','not_owner');
select walk_test.assert_that(public.session_booking_read(walk_test.u('5'),'booking',walk_test.bid('c8500000-0000-4000-8000-000000000002'))->'booking'->>'source'='walk_in','co-owner reads walk-in');
reset role;
select walk_test.expect_error($q$update private.session_bookings set source='player' where request_id='c8500000-0000-4000-8000-000000000002'$q$,'55000','immutable_booking');
select walk_test.expect_error($q$insert into private.session_bookings(session_id,requested_by,request_id,request_input,participants,spots,snapshot,status,expires_at,source)
  values(walk_test.sid('c8400000-0000-4000-8000-000000000001'),walk_test.u('1'),gen_random_uuid(),'{}','["X"]',1,'{}','pending',now()+interval '1 hour','walk_in')$q$,'23514');
-- Event failure rolls back the walk-in and its spots.
create function walk_test.fail_event() returns trigger language plpgsql as $$ begin if new.action='walk_in' then raise exception 'event failure'; end if; return new; end; $$;
create trigger walk_fail_event before insert on private.session_booking_events for each row execute function walk_test.fail_event();
set local role service_role;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000013','["Su"]',25000)$q$,'P0001');
select walk_test.assert_that(walk_test.reserved('c8400000-0000-4000-8000-000000000001')=5 and walk_test.bid('c8500000-0000-4000-8000-000000000013') is null,'event rollback');
reset role;
drop trigger walk_fail_event on private.session_booking_events;
-- Suspension stops new walk-ins but keeps removal; revocation removes retry and read access.
update public.venues set publication_status='suspended' where id='c8200000-0000-4000-8000-000000000001';
set local role service_role;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000014','["Su"]',25000)$q$,'P0002','venue_unavailable');
select walk_test.assert_that(walk_test.change('1','c8500000-0000-4000-8000-000000000008','cancel')->>'outcome'='changed','removal under suspension');
reset role;
update public.venues set publication_status='approved' where id='c8200000-0000-4000-8000-000000000001';
delete from private.venue_owners where user_id=walk_test.u('1');
set local role service_role;
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000002','["Di","Ed","Fe","Gi"]',100000)$q$,'42501','not_owner');
select walk_test.expect_error($q$select walk_test.walk('1','c8400000-0000-4000-8000-000000000001','c8500000-0000-4000-8000-000000000015','["Su"]',25000)$q$,'42501','not_owner');
select walk_test.expect_error($q$select public.session_booking_read(walk_test.u('1'),'booking',walk_test.bid('c8500000-0000-4000-8000-000000000002'))$q$,'42501','not_owner');
select walk_test.expect_error($q$select walk_test.change('1','c8500000-0000-4000-8000-000000000002','cancel')$q$,'42501','not_owner');
reset role;
-- The stored counter equals live spots for every session.
select walk_test.assert_that(not exists(select 1 from private.open_play_sessions s where s.reserved_spots<>coalesce((select sum(b.spots)
  from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)),'counter invariant');
rollback;
