-- Rollback-only T32 fixtures, relative to the database clock. Concurrency lives in hold-expiry-local.cjs.
begin;
create schema sweep_test;
create function sweep_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Hold sweep assertion failed: %',message; end if; end; $$;
create function sweep_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function sweep_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function sweep_test.u(n text) returns uuid language sql immutable as $$ select ('cb100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function sweep_test.c(n text) returns uuid language sql immutable as $$ select ('cb300000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function sweep_test.k(n text) returns uuid language sql immutable as $$ select ('cb500000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function sweep_test.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(sweep_test.u(actor),sweep_test.c(court),sweep_test.k(request),sweep_test.at(a),sweep_test.at(b),
  public.rental_booking_quote(sweep_test.u(actor),sweep_test.c(court),sweep_test.at(a),sweep_test.at(b))->'expected_quote'); $$;
create function sweep_test.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=sweep_test.k(request); $$;
create function sweep_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=sweep_test.k(request); $$;
create function sweep_test.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=sweep_test.k(request); $$;
create function sweep_test.join_play(actor text,session_request text,request text,names jsonb,total bigint) returns jsonb language sql as $$
select public.session_booking_request(sweep_test.u(actor),jsonb_build_object('session_id',sweep_test.sid(session_request),
  'request_id',sweep_test.k(request),'participants',names,'expected_total_centavos',total)); $$;
create function sweep_test.events(target uuid) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from (select action from private.rental_events where booking_id=target
  union all select action from private.session_booking_events where booking_id=target) e group by action) x; $$;
create function sweep_test.expired_by(target uuid) returns uuid language sql security definer set search_path='' as $$
select actor_user_id from private.rental_events where booking_id=target and action='expire'
  union all select actor_user_id from private.session_booking_events where booking_id=target and action='expire'; $$;
create function sweep_test.stored(target uuid) returns text language sql security definer set search_path='' as $$
select coalesce((select status from private.rental_bookings where id=target),(select status from private.session_bookings where id=target)); $$;
create function sweep_test.reserved(session_request text) returns integer language sql security definer set search_path='' as $$
select reserved_spots from private.open_play_sessions where request_id=sweep_test.k(session_request); $$;
-- Counters equal the stored live groups for every fixture session.
create function sweep_test.counters_match() returns boolean language sql security definer set search_path='' as $$
select not exists(select 1 from private.open_play_sessions s where s.venue_id='cb200000-0000-4000-8000-000000000001'
  and s.reserved_spots<>coalesce((select sum(b.spots) from private.session_bookings b where b.session_id=s.id and b.status in ('pending','confirmed')),0)); $$;
-- Trusted SQL only: stand in for operator policy and for time passing until a hold elapses.
create function sweep_test.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values('cb200000-0000-4000-8000-000000000001',$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
create function sweep_test.elapse(request text,ago interval) returns void language plpgsql security definer as $$
begin
  update private.court_allocations set expires_at=clock_timestamp()-ago where request_id=sweep_test.k(request);
  alter table private.session_bookings disable trigger session_booking_guard;
  update private.session_bookings set expires_at=clock_timestamp()-ago where request_id=sweep_test.k(request);
  alter table private.session_bookings enable trigger session_booking_guard;
end; $$;
grant usage on schema sweep_test to anon,authenticated,service_role;
grant execute on all functions in schema sweep_test to anon,authenticated,service_role;
insert into auth.users(id) select sweep_test.u(n::text) from generate_series(1,5) n;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('cb200000-0000-4000-8000-000000000001','Sweep Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select sweep_test.c(n::text),'cb200000-0000-4000-8000-000000000001',chr(64+n),'active' from generate_series(1,3) n;
insert into private.venue_owners(user_id,venue_id) values (sweep_test.u('1'),'cb200000-0000-4000-8000-000000000001');
select public.venue_schedule_save(sweep_test.u('1'),'cb200000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
select sweep_test.policy('approval');
-- Approval sessions on court C: S1 (8 spots) and S2 (4 spots).
select public.owner_session_create(sweep_test.u('1'),jsonb_build_object('venue_id','cb200000-0000-4000-8000-000000000001','request_id',sweep_test.k(n),
  'court_ids',jsonb_build_array(sweep_test.c('3')),'title','Sweep play','starts_at',sweep_test.at(a),'ends_at',sweep_test.at(b),
  'capacity',cap,'group_limit',4,'price_centavos',price)) from (values ('01',600,720,8,25000),('02',780,840,4,20000)) v(n,a,b,cap,price);

-- Only trusted SQL (cron) reaches the sweep.
select sweep_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  cross join (values ('anon'),('authenticated'),('service_role')) r(name)
  where n.nspname in ('public','private') and (p.proname like '%sweep%' or p.proname like 'booking_expiry%')
    and has_function_privilege(r.name,p.oid,'execute')),'no API role executes sweep functions');
set local role service_role;
select sweep_test.expect_error('select private.booking_expiry_sweep(10)','42501');
reset role;
select sweep_test.expect_error(format('select private.booking_expiry_sweep(%s)',n),'22023','invalid_input') from unnest(array['0','1001','null']) n;

-- Pending holds: rentals R10–R15 and groups G20–G24; R14 and G22 are accepted (firm).
set local role service_role;
select sweep_test.assert_that(r->'booking'->>'status'='pending','rental hold '||n) from (values
  ('2','1','10',600,660),('3','2','11',600,660),('4','1','12',720,780),('5','2','13',720,780),('2','1','14',840,900),('3','2','15',840,900)) v(p,c,n,a,b),
  lateral sweep_test.rent(p,c,n,a,b) r;
select sweep_test.assert_that(r->'booking'->>'status'='pending','group hold '||n) from (values
  ('2','01','20','["Ana","Ben"]',50000),('3','01','21','["Cy","Di","Ed"]',75000),('4','01','22','["Fe"]',25000),
  ('5','02','23','["Gi","Hu"]',40000),('2','02','24','["Ix"]',20000)) v(p,s,n,names,total),
  lateral sweep_test.join_play(p,s,n,names::jsonb,total) r;
select sweep_test.assert_that(public.rental_booking_change(sweep_test.u('1'),sweep_test.rid('14'),'accept')->'booking'->>'status'='confirmed'
  and public.session_booking_change(sweep_test.u('1'),sweep_test.gid('22'),'accept')->'booking'->>'status'='confirmed','firm R14/G22');
reset role;
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":0,"groups":0,"skipped":0,"failed":0,"more":false}','nothing elapsed');
select sweep_test.assert_that(sweep_test.events(sweep_test.rid('10'))='{"request":1}','live hold untouched');

-- Elapse holds at different ages; R10 was missed for a day. R13 is marked expired by a later acquisition on its court.
select sweep_test.elapse(n,ago::interval) from (values ('10','1 day'),('11','3 minutes'),('12','2 minutes'),('13','1 minute'),
  ('20','5 minutes'),('21','4 minutes'),('23','1 minute')) v(n,ago);
set local role service_role;
select sweep_test.assert_that(sweep_test.rent('4','2','16',720,780)->'booking'->>'status'='pending','acquisition takes R13 inventory');
reset role;
select sweep_test.assert_that((select state='expired' from private.court_allocations where id=sweep_test.rid('13'))
  and sweep_test.stored(sweep_test.rid('13'))='pending' and sweep_test.events(sweep_test.rid('13'))='{"request":1}','acquisition marks allocation only');
-- No sweep yet: reads and offers already treat every elapsed hold as expired and free.
select sweep_test.assert_that(public.rental_booking_read(sweep_test.u(p),sweep_test.rid(n))->'booking'->>'status'='expired'
  and sweep_test.stored(sweep_test.rid(n))='pending','read '||n) from (values ('2','10'),('3','11'),('4','12'),('5','13')) v(p,n);
select sweep_test.assert_that(public.session_booking_read(sweep_test.u(p),'booking',sweep_test.gid(n))->'booking'->>'status'='expired','read '||n)
  from (values ('2','20'),('3','21'),('5','23')) v(p,n);
select sweep_test.assert_that((public.session_booking_read(sweep_test.u('5'),'session',sweep_test.sid('01'))->'session'->>'available_spots')::integer=7
  and sweep_test.reserved('01')=6,'offer sees free spots before the counter catches up');
select sweep_test.assert_that(jsonb_array_length(public.rental_booking_read(sweep_test.u('1'),null,'cb200000-0000-4000-8000-000000000001')->'bookings')=2,
  'owner queue lists only live holds (R15, R16)');

-- Bounded batch: the oldest rental and the session with the oldest hold.
select sweep_test.assert_that(private.booking_expiry_sweep(1)='{"rentals":1,"groups":2,"skipped":0,"failed":0,"more":true}','batch of one');
select sweep_test.assert_that(sweep_test.stored(sweep_test.rid('10'))='expired' and sweep_test.stored(sweep_test.rid('11'))='pending'
  and sweep_test.reserved('01')=1 and sweep_test.stored(sweep_test.gid('23'))='pending','oldest first');
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":3,"groups":1,"skipped":0,"failed":0,"more":false}','rest of the backlog');
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":0,"groups":0,"skipped":0,"failed":0,"more":false}','repeat sweep is a no-op');
-- Items recheck under their locks, so a stale candidate (expired, firm or still live) changes nothing.
select sweep_test.assert_that(private.rental_sweep_hold(sweep_test.rid(n))='none','recheck '||n) from unnest(array['10','14','16']) n;
select sweep_test.assert_that(private.session_sweep_holds(sweep_test.sid('01'))=0 and private.session_sweep_holds(sweep_test.sid('02'))=0,'session recheck');
-- One system expire event per hold; the allocation ends at the hold expiry, not at sweep time.
select sweep_test.assert_that(sweep_test.stored(id)='expired' and sweep_test.events(id)='{"expire":1,"request":1}' and sweep_test.expired_by(id) is null,'swept '||id)
  from unnest(array[sweep_test.rid('10'),sweep_test.rid('11'),sweep_test.rid('12'),sweep_test.rid('13'),sweep_test.gid('20'),sweep_test.gid('21'),sweep_test.gid('23')]) id;
select sweep_test.assert_that(not exists(select 1 from private.court_allocations a join private.rental_bookings b on b.id=a.id
  where a.id=any(array[sweep_test.rid('10'),sweep_test.rid('11'),sweep_test.rid('12'),sweep_test.rid('13')])
    and (a.state<>'expired' or a.ended_at<>a.expires_at or b.updated_at<>a.expires_at)),'ended at expiry');
select sweep_test.assert_that(not exists(select 1 from private.session_bookings where id=any(array[sweep_test.gid('20'),sweep_test.gid('21'),sweep_test.gid('23')])
  and updated_at<>expires_at),'groups ended at expiry');
select sweep_test.assert_that(sweep_test.reserved('01')=1 and sweep_test.reserved('02')=1 and sweep_test.counters_match(),'counters released once');
select sweep_test.assert_that(sweep_test.stored(sweep_test.rid('14'))='confirmed' and sweep_test.events(sweep_test.rid('14'))='{"accept":1,"request":1}'
  and sweep_test.stored(sweep_test.gid('22'))='confirmed' and sweep_test.events(sweep_test.gid('22'))='{"accept":1,"request":1}'
  and sweep_test.stored(sweep_test.rid('16'))='pending','firm and live bookings untouched');

-- Commands after the sweep: same replies as after a command-side expiry; retries never revive.
set local role service_role;
select sweep_test.expect_error(format('select public.rental_booking_change(sweep_test.u(%L),sweep_test.rid(%L),%L)',a,n,cmd),'23514','invalid_transition')
  from (values ('1','10','accept'),('1','11','decline'),('4','12','cancel')) v(a,n,cmd);
select sweep_test.expect_error(format('select public.session_booking_change(sweep_test.u(%L),sweep_test.gid(%L),%L)',a,n,cmd),'23514','invalid_transition')
  from (values ('1','20','accept'),('1','21','decline'),('5','23','cancel')) v(a,n,cmd);
select sweep_test.assert_that(public.rental_booking_change(sweep_test.u('2'),sweep_test.rid('10'),'expire')->>'outcome'='existing','expire command is a no-op');
select sweep_test.assert_that((select r->>'outcome'='existing' and r->'booking'->>'status'='expired' from sweep_test.rent('2','1','10',600,660) r)
  and (select r->>'outcome'='existing' and r->'booking'->>'status'='expired' from sweep_test.join_play('2','01','20','["Ana","Ben"]',50000) r),'retries stay expired');
-- Released inventory resells exactly once.
select sweep_test.assert_that(sweep_test.rent('3','1','17',600,660)->>'outcome'='created'
  and sweep_test.join_play('5','01','25','["Jo","Ka","Lu","Mo"]',100000)->>'outcome'='created','resold');
reset role;
select sweep_test.assert_that(sweep_test.events(id)='{"expire":1,"request":1}','no new events '||id)
  from unnest(array[sweep_test.rid('10'),sweep_test.rid('11'),sweep_test.rid('12'),sweep_test.gid('20'),sweep_test.gid('21'),sweep_test.gid('23')]) id;
select sweep_test.assert_that(sweep_test.reserved('01')=5 and sweep_test.counters_match(),'resale counter');

-- A command that expires a hold first leaves the sweep nothing to record.
select sweep_test.elapse(n,'1 minute') from unnest(array['15','24']) n;
set local role service_role;
select sweep_test.assert_that(public.rental_booking_change(sweep_test.u('1'),sweep_test.rid('15'),'decline')->>'outcome'='expired'
  and public.session_booking_change(sweep_test.u('1'),sweep_test.gid('24'),'accept')->>'outcome'='expired','command-side expiry');
reset role;
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":0,"groups":0,"skipped":0,"failed":0,"more":false}','nothing left');
select sweep_test.assert_that(sweep_test.events(sweep_test.rid('15'))='{"expire":1,"request":1}' and sweep_test.expired_by(sweep_test.rid('15'))=sweep_test.u('1')
  and sweep_test.events(sweep_test.gid('24'))='{"expire":1,"request":1}' and sweep_test.reserved('02')=0,'one expiry each');

-- Lifecycle event checks hold even for trusted SQL.
select sweep_test.expect_error($q$insert into private.rental_events(booking_id,actor_user_id,action) values(sweep_test.rid('10'),null,'expire')$q$,'23505');
select sweep_test.expect_error($q$insert into private.session_booking_events(booking_id,actor_user_id,action) values(sweep_test.gid('20'),null,'expire')$q$,'23505');
select sweep_test.expect_error($q$insert into private.rental_events(booking_id,actor_user_id,action) values(sweep_test.rid('16'),null,'cancel')$q$,'23514');

-- A failing item rolls back alone and is retried by the next run.
set local role service_role;
select sweep_test.assert_that(sweep_test.rent('4','3','18',900,960)->'booking'->>'status'='pending'
  and sweep_test.join_play('3','02','26','["Ne"]',20000)->'booking'->>'status'='pending'
  and sweep_test.join_play('2','01','27','["Ol"]',25000)->'booking'->>'status'='pending','failure fixtures');
reset role;
select sweep_test.elapse(n,'1 minute') from unnest(array['18','26','27']) n;
create function sweep_test.fail_expire() returns trigger language plpgsql as $$ begin if new.action='expire' then raise exception 'event failure'; end if; return new; end; $$;
create trigger sweep_fail_expire before insert on private.rental_events for each row execute function sweep_test.fail_expire();
create trigger sweep_fail_expire before insert on private.session_booking_events for each row execute function sweep_test.fail_expire();
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":0,"groups":0,"skipped":0,"failed":3,"more":false}','every item failed alone');
select sweep_test.assert_that(sweep_test.stored(sweep_test.rid('18'))='pending' and (select state='active' from private.court_allocations where id=sweep_test.rid('18'))
  and sweep_test.stored(sweep_test.gid('26'))='pending' and sweep_test.reserved('02')=1 and sweep_test.reserved('01')=6
  and sweep_test.events(sweep_test.rid('18'))='{"request":1}' and sweep_test.events(sweep_test.gid('26'))='{"request":1}','failed items rolled back');
drop trigger sweep_fail_expire on private.session_booking_events;
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":0,"groups":2,"skipped":0,"failed":1,"more":false}','groups recover first');
drop trigger sweep_fail_expire on private.rental_events;
select sweep_test.assert_that(private.booking_expiry_sweep(100)='{"rentals":1,"groups":0,"skipped":0,"failed":0,"more":false}','rental recovers');
select sweep_test.assert_that(sweep_test.events(id)='{"expire":1,"request":1}','recovered once '||id)
  from unnest(array[sweep_test.rid('18'),sweep_test.gid('26'),sweep_test.gid('27')]) id;
select sweep_test.assert_that(sweep_test.reserved('02')=0 and sweep_test.reserved('01')=5 and sweep_test.counters_match(),'final counters');

-- Correctness never depends on the sweep: with the trigger gone, no candidates remain.
select sweep_test.assert_that(not exists(select 1 from private.rental_bookings b join private.court_allocations a on a.id=b.id
  where b.status='pending' and a.expires_at<=clock_timestamp())
  and not exists(select 1 from private.session_bookings where status='pending' and expires_at<=clock_timestamp()),'no elapsed pending rows');
rollback;
