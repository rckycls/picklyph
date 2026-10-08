-- Rollback-only T31 fixtures, relative to the database clock.
begin;
create schema ops_test;
create function ops_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Operations assertion failed: %',message; end if; end; $$;
create function ops_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function ops_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function ops_test.u(n text) returns uuid language sql immutable as $$ select ('c9100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ops_test.c(n text) returns uuid language sql immutable as $$ select ('c9300000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ops_test.k(n text) returns uuid language sql immutable as $$ select ('c9500000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function ops_test.quote(actor text,court text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_quote(ops_test.u(actor),ops_test.c(court),ops_test.at(a),ops_test.at(b))->'expected_quote'; $$;
create function ops_test.entry_with(actor text,court text,request text,a integer,b integer,guest text,quote jsonb) returns jsonb language sql as $$
select public.rental_booking_owner_entry(ops_test.u(actor),ops_test.c(court),ops_test.k(request),ops_test.at(a),ops_test.at(b),guest,quote); $$;
create function ops_test.entry(actor text,court text,request text,a integer,b integer,guest text) returns jsonb language sql as $$
select ops_test.entry_with(actor,court,request,a,b,guest,ops_test.quote(actor,court,a,b)); $$;
create function ops_test.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(ops_test.u(actor),ops_test.c(court),ops_test.k(request),ops_test.at(a),ops_test.at(b),ops_test.quote(actor,court,a,b)); $$;
create function ops_test.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=ops_test.k(request); $$;
create function ops_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=ops_test.k(request); $$;
create function ops_test.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=ops_test.k(request); $$;
create function ops_test.op(actor text,kind text,booking uuid,command text,method text default null,amount bigint default null) returns jsonb language sql as $$
select public.booking_operation(ops_test.u(actor),kind,booking,command,method,amount); $$;
create function ops_test.rental_day(request text) returns date language sql security definer set search_path='' as $$
select (starts_at at time zone 'Asia/Manila')::date from private.court_allocations where request_id=ops_test.k(request); $$;
create function ops_test.session_day(request text) returns date language sql security definer set search_path='' as $$
select (starts_at at time zone 'Asia/Manila')::date from private.open_play_sessions where request_id=ops_test.k(request); $$;
create function ops_test.events(target uuid) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from (select action from private.rental_events where booking_id=target
  union all select action from private.session_booking_events where booking_id=target) e group by action) x; $$;
-- Trusted SQL only: stand in for operator policy and for time passing until a booking starts.
create function ops_test.policy(text,text,boolean) returns void language sql security definer as $$
insert into private.venue_merchants(venue_id,active) values('c9200000-0000-4000-8000-000000000001',$3)
  on conflict (venue_id) do update set active=excluded.active;
insert into private.venue_policies(venue_id,confirmation,payment) values('c9200000-0000-4000-8000-000000000001',$1,$2)
  on conflict (venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=private.venue_policies.revision+1; $$;
create function ops_test.start_rental(request text) returns void language sql security definer as $$
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '90 minutes' where request_id=ops_test.k(request); $$;
create function ops_test.start_session(request text) returns void language plpgsql security definer as $$
begin
  alter table private.open_play_sessions disable trigger session_immutable;
  update private.open_play_sessions set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
    ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '90 minutes' where request_id=ops_test.k(request);
  alter table private.open_play_sessions enable trigger session_immutable;
end; $$;
grant usage on schema ops_test to anon,authenticated,service_role;
grant execute on all functions in schema ops_test to anon,authenticated,service_role;
insert into auth.users(id) select ops_test.u(n::text) from generate_series(1,6) n;
insert into private.account_roles(user_id,role) values (ops_test.u('6'),'admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('c9200000-0000-4000-8000-000000000001','Operations Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select ops_test.c(n::text),'c9200000-0000-4000-8000-000000000001',chr(64+n),'active' from generate_series(1,3) n;
insert into private.venue_owners(user_id,venue_id) values (ops_test.u('1'),'c9200000-0000-4000-8000-000000000001');
select public.venue_schedule_save(ops_test.u('1'),'c9200000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
-- Court B carries an open-play session; court A a block. Player rental R0 on A, R1 on C.
select public.owner_session_create(ops_test.u('1'),jsonb_build_object('venue_id','c9200000-0000-4000-8000-000000000001',
  'request_id',ops_test.k('01'),'court_ids',jsonb_build_array(ops_test.c('2')),'title','Ops play','starts_at',ops_test.at(600),'ends_at',ops_test.at(720),
  'capacity',8,'group_limit',4,'price_centavos',25000));
select public.court_allocation_block(ops_test.u('1'),ops_test.c('1'),ops_test.k('02'),ops_test.at(720),ops_test.at(780));
select ops_test.assert_that(ops_test.rent('2','1','10',600,660)->'booking'->>'status'='confirmed','player rental R0');
select ops_test.assert_that(ops_test.rent('2','3','11',600,660)->'booking'->>'status'='confirmed','player rental R1');

set local role service_role;
-- Outside rentals: only current owners, with a reviewed quote, on free inventory.
select ops_test.expect_error(format($q$select ops_test.entry(%L,'1','20',660,720,'Wei')$q$,n),'42501','not_owner') from unnest(array['2','6']) n;
select ops_test.expect_error(format($q$select ops_test.entry('1','1','20',660,720,%L)$q$,g),'22023','invalid_input')
  from unnest(array['',' ',repeat('a',61),E'Wei\tLi']) g;
select ops_test.expect_error($q$select public.rental_booking_owner_entry(ops_test.u('1'),ops_test.c('1'),ops_test.k('20'),ops_test.at(660),ops_test.at(720),null,ops_test.quote('1','1',660,720))$q$,'22023','invalid_input');
select ops_test.expect_error($q$select ops_test.entry_with('1','1','20',660,720,'Wei',ops_test.quote('1','1',660,720)||'{"total_centavos":1}')$q$,'40001','stale_quote');
select ops_test.expect_error($q$select ops_test.entry('1','1','20',630,690,'Wei')$q$,'23P01','allocation_conflict');
select ops_test.expect_error($q$select ops_test.entry('1','1','20',720,780,'Wei')$q$,'23P01','allocation_conflict');
select ops_test.expect_error($q$select ops_test.entry('1','2','20',630,690,'Wei')$q$,'23P01','allocation_conflict');
select ops_test.expect_error($q$select ops_test.entry('1','1','20',665,725,'Wei')$q$,'22023');
select ops_test.expect_error($q$select ops_test.entry_with('1','1','20',660,720,'Wei',null)$q$,'40001','stale_quote');
select ops_test.assert_that((select r->>'outcome'='created' and b->>'source'='owner' and b->>'guest_name'='Wei' and b->>'status'='confirmed'
    and b->'allocation'->'expires_at'='null'::jsonb and b->>'payment_status'='unpaid' and b->'operations'='{"attendance":"none","attendance_at":null,"payment":null}'::jsonb
    and (b->'snapshot'->>'total_centavos')::bigint=40000
  from ops_test.entry('1','1','20',660,720,' Wei ') r,lateral (select r->'booking' b) x),'owner entry created');
select ops_test.assert_that(ops_test.events(ops_test.rid('20'))='{"owner_entry":1}','one entry event');
-- The entry blocks players; retries return it; changed details or the player path with the same key are refused.
select ops_test.expect_error($q$select ops_test.rent('3','1','21',660,720)$q$,'23P01','allocation_conflict');
select ops_test.assert_that(ops_test.entry('1','1','20',660,720,'Wei')->>'outcome'='existing','entry retry');
select ops_test.expect_error($q$select ops_test.entry('1','1','20',660,720,'Mei')$q$,'23505','request_reused');
select ops_test.expect_error($q$select ops_test.rent('1','1','20',660,720)$q$,'23505','request_reused');
select ops_test.assert_that(ops_test.rent('1','3','22',900,960)->'booking'->>'source'='player','owner rents as a player');
select ops_test.expect_error($q$select ops_test.entry('1','3','22',900,960,'Wei')$q$,'23505','request_reused');
select ops_test.assert_that(ops_test.events(ops_test.rid('20'))='{"owner_entry":1}','retries add nothing');
-- Only current owners read entries; player history never lists them.
select ops_test.assert_that((select jsonb_array_length(r->'bookings')=1 and r->'bookings'->0->>'source'='player'
  from public.rental_booking_read(ops_test.u('1')) r),'history excludes entries');
select ops_test.expect_error($q$select public.rental_booking_read(ops_test.u('2'),ops_test.rid('20'))$q$,'42501','not_owner');
select ops_test.assert_that(public.rental_booking_read(ops_test.u('1'),ops_test.rid('20'))->'booking'->>'guest_name'='Wei','owner reads entry');
-- Any current owner cancels an entry before it starts; players and admins cannot; declining is invalid.
reset role;
insert into private.venue_owners(user_id,venue_id) values (ops_test.u('5'),'c9200000-0000-4000-8000-000000000001');
set local role service_role;
select ops_test.expect_error(format($q$select public.rental_booking_change(ops_test.u(%L),ops_test.rid('20'),'cancel')$q$,n),'42501','not_owner') from unnest(array['2','6']) n;
select ops_test.expect_error($q$select public.rental_booking_change(ops_test.u('1'),ops_test.rid('20'),'decline')$q$,'23514','invalid_transition');
select ops_test.assert_that(public.rental_booking_change(ops_test.u('1'),ops_test.rid('20'),'accept')->>'outcome'='existing','accept is a no-op');
select ops_test.assert_that(public.rental_booking_change(ops_test.u('5'),ops_test.rid('20'),'cancel')->'booking'->>'status'='cancelled','co-owner cancels entry');
select ops_test.assert_that(public.rental_booking_change(ops_test.u('1'),ops_test.rid('20'),'cancel')->>'outcome'='existing','cancel retry');
select ops_test.assert_that(ops_test.events(ops_test.rid('20'))='{"cancel":1,"owner_entry":1}','cancelled once');
select ops_test.assert_that(ops_test.rent('3','1','21',660,720)->'booking'->>'status'='confirmed','released inventory rebooks');
select ops_test.assert_that(ops_test.entry('1','1','20',660,720,'Wei')->'booking'->>'status'='cancelled','retry never revives');

-- Attendance and payments need a confirmed booking that has started.
select ops_test.assert_that(ops_test.entry('1','1','23',840,900,'Lin')->>'outcome'='created','entry E2');
select ops_test.assert_that(public.session_booking_request(ops_test.u('3'),jsonb_build_object('session_id',ops_test.sid('01'),'request_id',ops_test.k('30'),
  'participants','["Ana","Ben"]'::jsonb,'expected_total_centavos',50000))->'booking'->>'status'='confirmed','player group G1');
select ops_test.assert_that(public.session_walk_in(ops_test.u('1'),jsonb_build_object('session_id',ops_test.sid('01'),'request_id',ops_test.k('31'),
  'participants','["Cy"]'::jsonb,'expected_total_centavos',25000))->'booking'->>'status'='confirmed','walk-in W1');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('11'),'check_in')$q$,'55000','not_started');
select ops_test.expect_error($q$select ops_test.op('1','session',ops_test.gid('30'),'record_payment','cash',50000)$q$,'55000','not_started');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('20'),'check_in')$q$,'23514','invalid_transition');
reset role;
select ops_test.start_rental('11'); select ops_test.start_rental('23'); select ops_test.start_session('01');
create table ops_test.before as select b.id,b.status,b.updated_at,s.snapshot from private.rental_bookings b join private.rental_snapshots s on s.allocation_id=b.id;
set local role service_role;
-- Input, kind and access checks.
select ops_test.expect_error($q$select ops_test.op('1','session',ops_test.rid('11'),'check_in')$q$,'P0002','booking_not_found');
select ops_test.expect_error(format($q$select public.booking_operation(ops_test.u('1'),%s)$q$,args),'22023','invalid_input') from unnest(array[
  $a$'rental',ops_test.rid('11'),'arrive'$a$,$a$'court',ops_test.rid('11'),'check_in'$a$,$a$'rental',ops_test.rid('11'),'record_payment'$a$,
  $a$'rental',ops_test.rid('11'),'record_payment','cash'$a$,$a$'rental',ops_test.rid('11'),'record_payment','crypto',40000$a$,
  $a$'rental',ops_test.rid('11'),'record_payment','cash',-1$a$,$a$'rental',ops_test.rid('11'),'check_in','cash',40000$a$]) args;
select ops_test.expect_error(format($q$select ops_test.op(%L,'rental',ops_test.rid('11'),'check_in')$q$,n),'42501','not_owner') from unnest(array['2','6']) n;
-- Check-in, payment and completion are retry-safe, one event each, never touching status or snapshot.
select ops_test.assert_that((select r->>'outcome'='changed' and r->'booking'->>'status'='confirmed' and r->'booking'->'operations'->>'attendance'='checked_in'
  and r->'booking'->>'payment_status'='unpaid' from ops_test.op('1','rental',ops_test.rid('11'),'check_in') r),'check in');
select ops_test.assert_that(ops_test.op('5','rental',ops_test.rid('11'),'check_in')->>'outcome'='existing','check-in retry by co-owner');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('11'),'no_show')$q$,'23514','invalid_transition');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('11'),'record_payment','cash',39999)$q$,'23514','amount_mismatch');
select ops_test.assert_that((select r->'booking'->>'payment_status'='paid' and r->'booking'->'operations'->'payment'->>'method'='cash'
  and (r->'booking'->'operations'->'payment'->>'amount_centavos')::bigint=40000 from ops_test.op('1','rental',ops_test.rid('11'),'record_payment','cash',40000) r),'paid');
select ops_test.assert_that(ops_test.op('1','rental',ops_test.rid('11'),'record_payment','cash',40000)->>'outcome'='existing','payment retry');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('11'),'record_payment','ewallet',40000)$q$,'23505','payment_recorded');
select ops_test.assert_that(ops_test.op('1','rental',ops_test.rid('11'),'complete')->'booking'->'operations'->>'attendance'='completed','completed');
select ops_test.assert_that(ops_test.op('1','rental',ops_test.rid('11'),'complete')->>'outcome'='existing'
  and ops_test.op('1','rental',ops_test.rid('11'),'check_in')->>'outcome'='existing','complete/check-in retries');
select ops_test.assert_that(ops_test.events(ops_test.rid('11'))='{"check_in":1,"complete":1,"payment":1,"request":1}','one event each');
reset role;
select ops_test.assert_that(not exists(select 1 from ops_test.before x join private.rental_bookings b on b.id=x.id join private.rental_snapshots s on s.allocation_id=b.id
  where (b.status,b.updated_at,s.snapshot) is distinct from (x.status,x.updated_at,x.snapshot)),'status/snapshot unchanged');
set local role service_role;
-- No-show closes check-in and payment; completion needs a check-in; paid groups cannot be no-shows.
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('23'),'complete')$q$,'23514','invalid_transition');
select ops_test.assert_that(ops_test.op('1','rental',ops_test.rid('23'),'no_show')->'booking'->'operations'->>'attendance'='no_show','entry no-show');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('23'),'check_in')$q$,'23514','invalid_transition');
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('23'),'record_payment','cash',40000)$q$,'23514','invalid_transition');
select ops_test.assert_that(ops_test.op('1','session',ops_test.gid('30'),'record_payment','ewallet',50000)->'booking'->>'payment_status'='paid','group paid before check-in');
select ops_test.expect_error($q$select ops_test.op('1','session',ops_test.gid('30'),'no_show')$q$,'23514','invalid_transition');
select ops_test.assert_that(ops_test.op('1','session',ops_test.gid('30'),'check_in')->'booking'->>'status'='confirmed'
  and ops_test.op('1','session',ops_test.gid('30'),'complete')->'booking'->'operations'->>'attendance'='completed','group attended');
select ops_test.assert_that(ops_test.op('5','session',ops_test.gid('31'),'check_in')->'booking'->>'source'='walk_in','walk-in checked in');
select ops_test.assert_that(ops_test.events(ops_test.gid('30'))='{"check_in":1,"complete":1,"payment":1,"request":1}','group events');
-- Players read their own attendance and payment.
select ops_test.assert_that((select b->'operations'->>'attendance'='completed' and b->>'payment_status'='paid'
  from public.rental_booking_read(ops_test.u('2'),ops_test.rid('11')) r,lateral (select r->'booking' b) x),'player sees rental record');
select ops_test.assert_that((select b->'operations'->>'attendance'='completed' and b->'operations'->'payment'->>'method'='ewallet'
  from public.session_booking_read(ops_test.u('3'),'booking',ops_test.gid('30')) r,lateral (select r->'booking' b) x),'player sees group record');
-- Front desk: confirmed bookings starting on one Manila date, owners only.
select ops_test.assert_that((select array(select x->>'id' from jsonb_array_elements(r->'bookings') x order by 1)=array(select unnest(array[ops_test.rid('11'),ops_test.rid('23')])::text order by 1)
    and r->>'venue_id'='c9200000-0000-4000-8000-000000000001' and r->'next_cursor'='null'::jsonb
  from public.booking_operations_read(ops_test.u('1'),'rental','c9200000-0000-4000-8000-000000000001',
    ops_test.rental_day('11')) r),'rental day');
select ops_test.assert_that((select jsonb_array_length(r->'bookings')=2 and r::text like '%Cy%'
  from public.booking_operations_read(ops_test.u('5'),'session','c9200000-0000-4000-8000-000000000001',
    ops_test.session_day('01')) r),'group day');
select ops_test.assert_that((select jsonb_array_length(r->'bookings')=3
  from public.booking_operations_read(ops_test.u('1'),'rental','c9200000-0000-4000-8000-000000000001',(ops_test.at(0) at time zone 'Asia/Manila')::date) r),'future day: R0, the rebooked rental and the owner as player');
select ops_test.expect_error(format($q$select public.booking_operations_read(ops_test.u(%L),'rental','c9200000-0000-4000-8000-000000000001',current_date)$q$,n),'42501','not_owner')
  from unnest(array['2','6']) n;
select ops_test.expect_error($q$select public.booking_operations_read(ops_test.u('1'),'court','c9200000-0000-4000-8000-000000000001',current_date)$q$,'22023','invalid_input');
select ops_test.expect_error($q$select public.booking_operations_read(ops_test.u('1'),'rental','c9200000-0000-4000-8000-000000000001','2100-01-01')$q$,'22023','invalid_input');
-- Records are append-only, even for trusted SQL.
reset role;
select ops_test.expect_error($q$update private.booking_operations set attendance='none',attendance_at=null where booking_id=ops_test.rid('11')$q$,'55000','immutable_operation');
select ops_test.expect_error($q$update private.booking_operations set payment_method='card' where booking_id=ops_test.rid('11')$q$,'55000','immutable_operation');
select ops_test.expect_error($q$update private.booking_operations set attendance='completed',attendance_at=now() where booking_id=ops_test.rid('23')$q$,'55000','immutable_operation');
select ops_test.expect_error($q$update private.rental_bookings set source='player' where id=ops_test.rid('23')$q$,'55000','immutable_booking');
select ops_test.expect_error($q$insert into private.booking_operations(booking_id,rental_booking_id,session_booking_id) values(ops_test.rid('20'),ops_test.rid('20'),ops_test.gid('31'))$q$,'23514');
-- An event failure rolls back the record.
create function ops_test.fail_event() returns trigger language plpgsql as $$ begin if new.action in ('check_in','complete') then raise exception 'event failure'; end if; return new; end; $$;
create trigger ops_fail_event before insert on private.session_booking_events for each row execute function ops_test.fail_event();
set local role service_role;
select ops_test.expect_error($q$select ops_test.op('1','session',ops_test.gid('31'),'complete')$q$,'P0001');
select ops_test.assert_that(public.session_booking_read(ops_test.u('1'),'booking',ops_test.gid('31'))->'booking'->'operations'->>'attendance'='checked_in'
  and ops_test.events(ops_test.gid('31'))='{"check_in":1,"walk_in":1}','group event rollback');
reset role;
drop trigger ops_fail_event on private.session_booking_events;
create trigger ops_fail_event before insert on private.rental_events for each row execute function ops_test.fail_event();
select ops_test.assert_that(ops_test.entry('1','2','24',960,1020,'Kai')->>'outcome'='created','entry E3');
select ops_test.start_rental('24');
set local role service_role;
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('24'),'check_in')$q$,'P0001');
select ops_test.assert_that(public.rental_booking_read(ops_test.u('1'),ops_test.rid('24'))->'booking'->'operations'->>'attendance'='none'
  and ops_test.events(ops_test.rid('24'))='{"owner_entry":1}','event rollback');
reset role;
drop trigger ops_fail_event on private.rental_events;
-- Suspension stops new entries but not front-desk records; revocation removes access.
create table ops_test.saved as select ops_test.quote('1','3',1080,1140) q;
grant select on ops_test.saved to service_role;
update public.venues set publication_status='suspended' where id='c9200000-0000-4000-8000-000000000001';
set local role service_role;
select ops_test.expect_error($q$select ops_test.entry_with('1','3','25',1080,1140,'Kai',(select q from ops_test.saved))$q$,'P0002','venue_unavailable');
select ops_test.assert_that(ops_test.op('1','rental',ops_test.rid('24'),'check_in')->>'outcome'='changed','check-in under suspension');
reset role;
update public.venues set publication_status='approved' where id='c9200000-0000-4000-8000-000000000001';
select ops_test.policy('instant','online',true);
set local role service_role;
select ops_test.expect_error($q$select ops_test.entry_with('1','3','25',1080,1140,'Kai',(select q from ops_test.saved))$q$,'23514','arrival_unavailable');
reset role;
delete from private.venue_owners where user_id=ops_test.u('1');
set local role service_role;
select ops_test.expect_error($q$select ops_test.op('1','rental',ops_test.rid('24'),'complete')$q$,'42501','not_owner');
select ops_test.expect_error($q$select ops_test.entry_with('1','1','20',660,720,'Wei',(select q from ops_test.saved))$q$,'42501','not_owner');
select ops_test.assert_that(ops_test.op('5','rental',ops_test.rid('24'),'complete')->>'outcome'='changed','co-owner completes');
reset role;
-- API roles reach nothing directly.
set local role authenticated;
select ops_test.expect_error($q$select ops_test.op('5','rental',ops_test.rid('24'),'complete')$q$,'42501');
select ops_test.expect_error($q$select * from private.booking_operations$q$,'42501');
reset role;
rollback;
