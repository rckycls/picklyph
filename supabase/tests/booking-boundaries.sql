-- Rollback-only T33 regressions: arrival-booking cancellation, no-show and the 24-hour refund cutoff at exact instants.
-- Inside this transaction every public/private function that reads clock_timestamp() is redefined to read bound_test.clock(),
-- a frozen clock this file moves; the rollback restores the real definitions. Real-clock races live in the T24–T32 suites.
begin;
create schema bound_test;
create function bound_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Boundary assertion failed: %',message; end if; end; $$;
create function bound_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function bound_test.clock() returns timestamptz language sql volatile as $$ select current_setting('bound_test.now')::timestamptz; $$;
create function bound_test.set_clock(t timestamptz) returns void language plpgsql as $$ begin perform set_config('bound_test.now',t::text,true); end; $$;
-- Manila minutes from midnight, three days from today. S = at(600) is the main start; S0 starts at at(480).
create function bound_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+3)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function bound_test.u(n integer) returns uuid language sql immutable as $$ select ('cd100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function bound_test.v() returns uuid language sql immutable as $$ select 'cd200000-0000-4000-8000-000000000001'::uuid; $$;
create function bound_test.c(n integer) returns uuid language sql immutable as $$ select ('cd300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function bound_test.k(name text) returns uuid language sql immutable as $$ select md5('t33:'||name)::uuid; $$;
create function bound_test.rid(name text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=bound_test.k(name); $$;
create function bound_test.sid(name text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=bound_test.k(name); $$;
create function bound_test.gid(name text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=bound_test.k(name); $$;
create function bound_test.rent(actor integer,court integer,name text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(bound_test.u(actor),bound_test.c(court),bound_test.k(name),bound_test.at(a),bound_test.at(b),
  public.rental_booking_quote(bound_test.u(actor),bound_test.c(court),bound_test.at(a),bound_test.at(b))->'expected_quote'); $$;
create function bound_test.session(name text,court integer,a integer,b integer,capacity integer) returns jsonb language sql as $$
select public.owner_session_create(bound_test.u(1),jsonb_build_object('venue_id',bound_test.v(),'request_id',bound_test.k(name),
  'court_ids',jsonb_build_array(bound_test.c(court)),'title','Boundary play '||name,'starts_at',bound_test.at(a),'ends_at',bound_test.at(b),
  'capacity',capacity,'group_limit',4,'price_centavos',25000)); $$;
create function bound_test.join_play(actor integer,session text,name text) returns jsonb language sql as $$
select public.session_booking_request(bound_test.u(actor),jsonb_build_object('session_id',bound_test.sid(session),'request_id',bound_test.k(name),
  'participants',jsonb_build_array('Ana','Ben'),'expected_total_centavos',50000)); $$;
create function bound_test.walk_in(name text) returns jsonb language sql as $$
select public.session_walk_in(bound_test.u(1),jsonb_build_object('session_id',bound_test.sid('S1'),'request_id',bound_test.k(name),
  'participants',jsonb_build_array('Walk In'),'expected_total_centavos',25000)); $$;
-- Player cancellation (or owner removal of an owner entry or walk-in) of a rental or group by key name.
create function bound_test.cancel(actor integer,name text) returns jsonb language plpgsql as $$
begin
  if bound_test.rid(name) is not null then return public.rental_booking_change(bound_test.u(actor),bound_test.rid(name),'cancel'); end if;
  return public.session_booking_change(bound_test.u(actor),bound_test.gid(name),'cancel');
end; $$;
-- Owner front-desk records; a payment is cash for the given amount.
create function bound_test.op(name text,command text,amount bigint default null) returns jsonb language sql as $$
select public.booking_operation(bound_test.u(1),case when bound_test.rid(name) is null then 'session' else 'rental' end,
  coalesce(bound_test.rid(name),bound_test.gid(name)),command,case when amount is not null then 'cash' end,amount); $$;
-- Trusted SQL stands in for the owner's policy screen and merchant activation (T36).
create function bound_test.policy(text,text,boolean) returns void language sql security definer as $$
insert into private.venue_merchants(venue_id,active) values(bound_test.v(),$3) on conflict (venue_id) do update set active=excluded.active;
insert into private.venue_policies(venue_id,confirmation,payment) values(bound_test.v(),$1,$2)
  on conflict (venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=private.venue_policies.revision+1; $$;
create function bound_test.current_policy() returns jsonb language sql security definer set search_path='' as $$
select private.venue_policy_view(bound_test.v()); $$;
create function bound_test.schedule_revision() returns text language sql security definer set search_path='' as $$
select revision::text from private.venue_schedules where venue_id=bound_test.v(); $$;
create function bound_test.rate(hourly integer) returns jsonb language sql as $$
select public.venue_schedule_save(bound_test.u(1),bound_test.v(),bound_test.schedule_revision(),
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',hourly))))) from generate_series(1,7)),'exceptions','[]'::jsonb)); $$;
create function bound_test.snapshot(name text) returns jsonb language sql security definer set search_path='' as $$
select coalesce((select snapshot from private.rental_snapshots where allocation_id=bound_test.rid(name)),
  (select snapshot from private.session_bookings where id=bound_test.gid(name))); $$;
create function bound_test.hold(name text) returns timestamptz language sql security definer set search_path='' as $$
select coalesce((select expires_at from private.court_allocations where id=bound_test.rid(name)),
  (select expires_at from private.session_bookings where id=bound_test.gid(name))); $$;
create function bound_test.allocation_state(name text) returns text language sql security definer set search_path='' as $$
select state from private.court_allocations where id=bound_test.rid(name); $$;
create function bound_test.reserved(session text) returns integer language sql security definer set search_path='' as $$
select reserved_spots from private.open_play_sessions where id=bound_test.sid(session); $$;
create function bound_test.events(name text) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from (
  select action from private.rental_events where booking_id=bound_test.rid(name)
  union all select action from private.session_booking_events where booking_id=bound_test.gid(name)) e group by action) x; $$;
-- Every fixture booking: player cancellations happened before the start; attendance and payments at or after it;
-- only confirmed bookings carry a payment; each session's counter equals its live spots.
create function bound_test.timeline_ok() returns boolean language sql security definer set search_path='' as $$
select not exists(select 1 from private.rental_bookings b join private.court_allocations a on a.id=b.id
    where a.venue_id=bound_test.v() and b.status='cancelled' and b.source='player' and b.updated_at>=a.starts_at)
  and not exists(select 1 from private.session_bookings b join private.open_play_sessions s on s.id=b.session_id
    where s.venue_id=bound_test.v() and b.status='cancelled' and b.source='player' and b.updated_at>=s.starts_at)
  and not exists(select 1 from private.booking_operations o
    left join private.rental_bookings r on r.id=o.rental_booking_id left join private.court_allocations a on a.id=r.id
    left join private.session_bookings g on g.id=o.session_booking_id left join private.open_play_sessions s on s.id=g.session_id
    where coalesce(a.venue_id,s.venue_id)=bound_test.v() and (coalesce(r.status,g.status)<>'confirmed' and o.paid_at is not null
      or o.attendance_at<coalesce(a.starts_at,s.starts_at) or o.paid_at<coalesce(a.starts_at,s.starts_at)))
  and not exists(select 1 from private.open_play_sessions s where s.venue_id=bound_test.v()
    and s.reserved_spots<>coalesce((select sum(b.spots) from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)); $$;
-- The refund rule T40 must implement, pinned here: a player cancellation is refund-eligible when it happens at or before the
-- snapshot start minus the snapshot cutoff (24 hours). Only the reply's stored cancellation instant and locked snapshot feed it.
create function bound_test.refund_eligible(booking jsonb) returns boolean language sql stable as $$
select booking->>'status'='cancelled' and (booking->>'updated_at')::timestamptz<=(booking->'snapshot'->>'starts_at')::timestamptz
  -make_interval(hours=>coalesce(booking->'snapshot'->'policy'->>'player_refund_cutoff_hours',booking->'snapshot'->>'refund_cutoff_hours')::integer); $$;
create table bound_test.locked(name text primary key,snapshot jsonb not null);
create table bound_test.replies(name text primary key,reply jsonb not null);
grant usage on schema bound_test to anon,authenticated,service_role;
grant execute on all functions in schema bound_test to anon,authenticated,service_role;
grant select,insert on bound_test.locked,bound_test.replies to service_role;

-- Freeze the clock: redefine (this transaction only) every application function that reads the real one.
do $$
declare f oid; n integer:=0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid=p.pronamespace
    where s.nspname in ('public','private') and p.prokind='f' and p.prosrc ~ 'clock_timestamp\s*\('
      and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
  loop
    execute regexp_replace(pg_get_functiondef(f),'(pg_catalog\.)?clock_timestamp\s*\(\s*\)','bound_test.clock()','g'); n:=n+1;
  end loop;
  perform bound_test.assert_that(n>=10,format('frozen clock rewrote %s functions',n));
end; $$;
select bound_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace s on s.oid=p.pronamespace
  where s.nspname in ('public','private') and p.prosrc ~ 'clock_timestamp\s*\('),'no application function reads the real clock');
select bound_test.assert_that(p.prosrc like '%bound_test.clock()%','frozen clock in '||p.oid::regprocedure) from pg_proc p where p.oid in (
  'public.rental_booking_change(uuid,uuid,text)'::regprocedure,'public.session_booking_change(uuid,uuid,text)'::regprocedure,
  'public.booking_operation(uuid,text,uuid,text,text,bigint)'::regprocedure,'public.session_booking_request(uuid,jsonb)'::regprocedure,
  'public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb)'::regprocedure,'private.allocation_release(uuid)'::regprocedure);

-- T0, three days before S: an owner, seven players, ten courts at 400.00/hour around the clock.
select bound_test.set_clock(bound_test.at(-3600));
insert into auth.users(id) select bound_test.u(n) from generate_series(1,8) n;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (bound_test.v(),'Boundary Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select bound_test.c(n),bound_test.v(),'Court '||n,'active' from generate_series(1,10) n;
insert into private.venue_owners(user_id,venue_id) values (bound_test.u(1),bound_test.v());
set local role service_role;
select bound_test.rate(40000);
-- S2 snapshots approval; S0 (24-hour cases) and S1 snapshot instant. 250.00 per person.
select bound_test.policy('approval','arrival',false);
select bound_test.assert_that(bound_test.session('S2',10,600,660,8)->'session'->'snapshot'->'policy'->>'confirmation'='approval','S2 approval');
select bound_test.policy('instant','arrival',false);
select bound_test.assert_that(bound_test.session(name,9,a,b,cap)->'session'->'snapshot'->'policy'->>'confirmation'='instant',name||' instant')
  from (values ('S0',480,540,8),('S1',600,660,12)) v(name,a,b,cap);
-- Instant arrival bookings, all confirmed: r24*/g24* for the cutoff, the rest for the start.
select bound_test.assert_that(r->'booking'->>'status'='confirmed' and (r->'booking'->'snapshot'->>'total_centavos')::integer=40000,'rental '||name)
  from (values (2,1,'r24a',480,540),(3,2,'r24b',480,540),(4,3,'r24c',480,540),
    (2,1,'rc1',600,660),(3,2,'rc2',600,660),(4,3,'rn2',600,660),(5,4,'rp',600,660)) v(actor,court,name,a,b),
  lateral bound_test.rent(actor,court,name,a,b) r;
select bound_test.assert_that(public.rental_booking_owner_entry(bound_test.u(1),bound_test.c(5),bound_test.k('ro'),bound_test.at(600),bound_test.at(660),'Desk guest',
  public.rental_booking_quote(bound_test.u(1),bound_test.c(5),bound_test.at(600),bound_test.at(660))->'expected_quote')->'booking'->>'status'='confirmed','owner entry ro');
select bound_test.assert_that(r->'booking'->>'status'='confirmed' and (r->'booking'->'snapshot'->>'total_centavos')::integer=50000,'group '||name)
  from (values (2,'S0','g24a'),(3,'S0','g24b'),(4,'S0','g24c'),(2,'S1','gc1'),(3,'S1','gc2'),(4,'S1','gn2'),(5,'S1','gp')) v(actor,session,name),
  lateral bound_test.join_play(actor,session,name) r;
select bound_test.assert_that(bound_test.walk_in(name)->'booking'->>'status'='confirmed','walk-in '||name) from unnest(array['w1','wr1','wr2']) name;
insert into bound_test.locked select name,bound_test.snapshot(name) from unnest(array['r24a','r24b','r24c','rc1','rc2','rn2','rp','ro',
  'g24a','g24b','g24c','gc1','gc2','gn2','gp','w1','wr1','wr2']) name;
select bound_test.assert_that(bound_test.reserved('S0')=6 and bound_test.reserved('S1')=11,'spots taken');

-- Later edit 1 (T0 + 1 minute): approval and 600.00/hour. New quotes see it, at the frozen instant.
select bound_test.set_clock(bound_test.at(-3599));
select bound_test.policy('approval','arrival',false);
select bound_test.rate(60000);
select bound_test.assert_that(q->'policy'->>'confirmation'='approval' and (q->>'total_centavos')::integer=60000
  and (q->>'quoted_at')::timestamptz=bound_test.at(-3599),'edit 1 applies to new quotes')
  from public.rental_booking_quote(bound_test.u(8),bound_test.c(8),bound_test.at(600),bound_test.at(660)) q;

-- 24-hour cutoff of S0 = at(480) - 24 h = at(-960). Arrival cancellation stays open on both sides; refund eligibility
-- (inclusive at exactly 24 hours) follows the locked snapshot, and nothing was collected, so nothing is owed.
select bound_test.set_clock(bound_test.at(-960)-interval '1 millisecond');
insert into bound_test.replies select name,bound_test.cancel(actor,name) from (values (2,'r24a'),(2,'g24a')) v(actor,name);
select bound_test.set_clock(bound_test.at(-960));
insert into bound_test.replies select name,bound_test.cancel(actor,name) from (values (3,'r24b'),(3,'g24b')) v(actor,name);
select bound_test.set_clock(bound_test.at(-960)+interval '1 millisecond');
insert into bound_test.replies select name,bound_test.cancel(actor,name) from (values (4,'r24c'),(4,'g24c')) v(actor,name);
select bound_test.assert_that(r.reply->>'outcome'='changed' and b->>'status'='cancelled'
  and (b->>'updated_at')::timestamptz=bound_test.at(-960)+delta::interval and bound_test.refund_eligible(b)=eligible
  and b->'snapshot'=l.snapshot and b->'snapshot'->'policy'->>'confirmation'='instant' and b->'snapshot'->'policy'->>'payment'='arrival'
  and coalesce(b->'snapshot'->'policy'->>'player_refund_cutoff_hours',b->'snapshot'->>'refund_cutoff_hours')='24'
  and (b->'snapshot'->>'total_centavos')::integer=total and b->>'payment_method'='arrival' and b->>'payment_status'='unpaid'
  and b->'operations'->>'attendance'='none' and b->'operations'->'payment'='null'::jsonb,'24-hour cutoff '||v.name)
  from (values ('r24a','-1 millisecond',true,40000),('g24a','-1 millisecond',true,50000),('r24b','0',true,40000),('g24b','0',true,50000),
    ('r24c','1 millisecond',false,40000),('g24c','1 millisecond',false,50000)) v(name,delta,eligible,total)
  join bound_test.replies r on r.name=v.name join bound_test.locked l on l.name=v.name cross join lateral (select r.reply->'booking' b) x;
select bound_test.assert_that(bound_test.current_policy()->>'confirmation'='approval','venue moved on to approval');
select bound_test.assert_that(bound_test.allocation_state(n)='released','cutoff release '||n) from unnest(array['r24a','r24b','r24c']) n;
select bound_test.assert_that(bound_test.reserved('S0')=0,'cutoff groups released');

-- S - 90 minutes, still approval: pending holds, capped at the start (S2 snapshots approval for groups).
select bound_test.set_clock(bound_test.at(510));
select bound_test.assert_that(r->'booking'->>'status'='pending' and bound_test.hold(name)=bound_test.at(600),'rental hold capped at start '||name)
  from (values (6,6,'rh1'),(7,7,'rh2')) v(actor,court,name), lateral bound_test.rent(actor,court,name,600,660) r;
select bound_test.assert_that(r->'booking'->>'status'='pending' and bound_test.hold(name)=bound_test.at(600),'group hold capped at start '||name)
  from (values (6,'gh1'),(7,'gh2')) v(actor,name), lateral bound_test.join_play(actor,'S2',name) r;
insert into bound_test.locked select name,bound_test.snapshot(name) from unnest(array['rh1','rh2','gh1','gh2']) name;

-- Later edit 2 (S - 85 minutes): instant, online only (merchant active), 800.00/hour. New arrival rentals stop.
select bound_test.set_clock(bound_test.at(515));
select bound_test.policy('instant','online',true);
select bound_test.rate(80000);
select bound_test.assert_that(bound_test.current_policy()->>'payment'='online','venue moved on to online only');
select bound_test.expect_error('select public.rental_booking_quote(bound_test.u(8),bound_test.c(8),bound_test.at(600),bound_test.at(660))','23514','arrival_unavailable');

-- Start - 1 ms: player cancellation is open (confirmed and pending, rentals and groups); front-desk records are not.
select bound_test.set_clock(bound_test.at(600)-interval '1 millisecond');
insert into bound_test.replies select name,bound_test.cancel(actor,name) from (values (2,'rc1'),(2,'gc1'),(6,'rh1'),(6,'gh1')) v(actor,name);
select bound_test.assert_that(r.reply->>'outcome'='changed' and r.reply->'booking'->>'status'='cancelled'
  and (r.reply->'booking'->>'updated_at')::timestamptz=bound_test.clock() and not bound_test.refund_eligible(r.reply->'booking')
  and r.reply->'booking'->'snapshot'=l.snapshot and r.reply->'booking'->>'payment_status'='unpaid','cancel at start -1 ms '||r.name)
  from bound_test.replies r join bound_test.locked l using(name) where r.name in ('rc1','gc1','rh1','gh1');
select bound_test.assert_that(bound_test.allocation_state(n)='released','start release '||n) from unnest(array['rc1','rh1']) n;
select bound_test.assert_that(bound_test.reserved('S1')=9 and bound_test.reserved('S2')=2,'start spots released');
select bound_test.expect_error(format('select bound_test.op(%L,%L)',name,'no_show'),'55000','not_started') from unnest(array['rc2','ro','gc2','w1']) name;
select bound_test.expect_error($q$select bound_test.op('rp','record_payment',40000)$q$,'55000','not_started');

-- Start: player cancellation has closed, and a hold capped at the start has just elapsed...
select bound_test.set_clock(bound_test.at(600));
select bound_test.expect_error(format('select bound_test.cancel(%s,%L)',actor,name),'23514','invalid_transition')
  from (values (3,'rc2'),(3,'gc2'),(1,'ro')) v(actor,name);
insert into bound_test.replies select name,bound_test.cancel(actor,name) from (values (7,'rh2'),(7,'gh2')) v(actor,name);
select bound_test.assert_that(r.reply->>'outcome'='expired' and r.reply->'booking'->>'status'='expired'
  and (r.reply->'booking'->>'updated_at')::timestamptz=bound_test.at(600),'hold elapsed at start '||r.name) from bound_test.replies r where r.name in ('rh2','gh2');
select bound_test.assert_that(bound_test.allocation_state('rh2')='expired' and bound_test.reserved('S2')=0,'elapsed holds released');
-- ...and the venue records from the same instant, so there is no gap and no overlap. Rentals, owner entries, groups, walk-ins.
select bound_test.assert_that(r->>'outcome'='changed' and r->'booking'->>'status'='confirmed' and r->'booking'->'operations'->>'attendance'='no_show'
  and (r->'booking'->'operations'->>'attendance_at')::timestamptz=bound_test.at(600) and r->'booking'->>'payment_status'='unpaid','no-show at start '||name)
  from unnest(array['rc2','ro','gc2','w1']) name, lateral bound_test.op(name,'no_show') r;
-- Arrival payments equal the locked total, never the edited rates.
select bound_test.expect_error(format($q$select bound_test.op('rp','record_payment',%s)$q$,amount),'23514','amount_mismatch') from unnest(array[60000,80000]) amount;
select bound_test.assert_that(r->'booking'->>'payment_status'='paid' and (r->'booking'->'operations'->'payment'->>'amount_centavos')::integer=total
  and (r->'booking'->'operations'->'payment'->>'recorded_at')::timestamptz=bound_test.at(600),'payment at start '||name)
  from (values ('rp',40000),('gp',50000)) v(name,total), lateral bound_test.op(name,'record_payment',total) r;
select bound_test.expect_error(format('select bound_test.op(%L,%L)',name,'no_show'),'23514','invalid_transition') from unnest(array['rp','gp']) name;
-- Cancelled and expired arrival bookings never take a payment, so no refund can ever be owed for one.
select bound_test.expect_error(format('select bound_test.op(%L,%L,%s)',name,'record_payment',amount),'23514','invalid_transition')
  from (values ('r24a',40000),('g24c',50000),('rc1',40000),('gc1',50000),('rh2',60000),('gh2',50000)) v(name,amount);

-- Start + 1 ms: still closed to players; no-shows record at the current instant; repeats return the record.
select bound_test.set_clock(bound_test.at(600)+interval '1 millisecond');
select bound_test.expect_error(format('select bound_test.cancel(%s,%L)',actor,name),'23514','invalid_transition')
  from (values (4,'rn2'),(4,'gn2'),(3,'rc2'),(3,'gc2')) v(actor,name);
select bound_test.assert_that(r->>'outcome'='changed' and r->'booking'->'operations'->>'attendance'='no_show'
  and (r->'booking'->'operations'->>'attendance_at')::timestamptz=bound_test.clock(),'no-show after start '||name)
  from unnest(array['rn2','gn2']) name, lateral bound_test.op(name,'no_show') r;
select bound_test.assert_that(r->>'outcome'='existing' and (r->'booking'->'operations'->>'attendance_at')::timestamptz=bound_test.at(600),'no-show repeat '||name)
  from unnest(array['rc2','gc2']) name, lateral bound_test.op(name,'no_show') r;

-- Owners remove a walk-in until the session ends (end = at(660)).
select bound_test.set_clock(bound_test.at(660)-interval '1 millisecond');
select bound_test.assert_that(bound_test.cancel(1,'wr1')->'booking'->>'status'='cancelled','walk-in removal at end -1 ms');
select bound_test.set_clock(bound_test.at(660));
select bound_test.expect_error($q$select bound_test.cancel(1,'wr2')$q$,'23514','invalid_transition');

-- Through two policy edits, two rate edits, cancellations, expiries, no-shows and payments: snapshots never moved,
-- each action recorded once, and the timeline holds for every fixture booking.
select bound_test.assert_that(bound_test.snapshot(name)=snapshot,'snapshot unchanged '||name) from bound_test.locked;
select bound_test.assert_that(bound_test.events(name)=expected::jsonb,'events '||name) from (values
  ('r24a','{"request":1,"cancel":1}'),('r24b','{"request":1,"cancel":1}'),('r24c','{"request":1,"cancel":1}'),
  ('g24a','{"request":1,"cancel":1}'),('g24b','{"request":1,"cancel":1}'),('g24c','{"request":1,"cancel":1}'),
  ('rc1','{"request":1,"cancel":1}'),('gc1','{"request":1,"cancel":1}'),('rh1','{"request":1,"cancel":1}'),('gh1','{"request":1,"cancel":1}'),
  ('rh2','{"request":1,"expire":1}'),('gh2','{"request":1,"expire":1}'),('rc2','{"request":1,"no_show":1}'),('gc2','{"request":1,"no_show":1}'),
  ('rn2','{"request":1,"no_show":1}'),('gn2','{"request":1,"no_show":1}'),('ro','{"owner_entry":1,"no_show":1}'),('w1','{"walk_in":1,"no_show":1}'),
  ('rp','{"request":1,"payment":1}'),('gp','{"request":1,"payment":1}'),('wr1','{"walk_in":1,"cancel":1}'),('wr2','{"walk_in":1}')) v(name,expected);
select bound_test.assert_that(bound_test.reserved('S1')=8 and bound_test.timeline_ok(),'timeline and counters');
rollback;
