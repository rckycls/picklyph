-- Rollback-only T40a fixtures, relative to the database clock.
begin;
create schema vc_test;
create function vc_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Venue cancellation assertion failed: %',message; end if; end; $$;
create function vc_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function vc_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function vc_test.u(n text) returns uuid language sql immutable as $$ select ('ca100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function vc_test.c(n text) returns uuid language sql immutable as $$ select ('ca300000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function vc_test.k(n text) returns uuid language sql immutable as $$ select ('ca500000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function vc_test.v() returns uuid language sql immutable as $$ select 'ca200000-0000-4000-8000-000000000001'::uuid; $$;
create function vc_test.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=vc_test.k(request); $$;
create function vc_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=vc_test.k(request); $$;
create function vc_test.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=vc_test.k(request); $$;
create function vc_test.quote(actor text,court text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_quote(vc_test.u(actor),vc_test.c(court),vc_test.at(a),vc_test.at(b))->'expected_quote'; $$;
create function vc_test.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(vc_test.u(actor),vc_test.c(court),vc_test.k(request),vc_test.at(a),vc_test.at(b),vc_test.quote(actor,court,a,b)); $$;
create function vc_test.entry(actor text,court text,request text,a integer,b integer,guest text) returns jsonb language sql as $$
select public.rental_booking_owner_entry(vc_test.u(actor),vc_test.c(court),vc_test.k(request),vc_test.at(a),vc_test.at(b),guest,vc_test.quote(actor,court,a,b)); $$;
create function vc_test.session(actor text,request text,court text,a integer,b integer) returns jsonb language sql as $$
select public.owner_session_create(vc_test.u(actor),jsonb_build_object('venue_id',vc_test.v(),'request_id',vc_test.k(request),
  'court_ids',jsonb_build_array(vc_test.c(court)),'title','Fixture play','starts_at',vc_test.at(a),'ends_at',vc_test.at(b),
  'capacity',8,'group_limit',4,'price_centavos',25000)); $$;
create function vc_test.group_request(actor text,session text,request text,names jsonb) returns jsonb language sql as $$
select public.session_booking_request(vc_test.u(actor),jsonb_build_object('session_id',vc_test.sid(session),'request_id',vc_test.k(request),
  'participants',names,'expected_total_centavos',25000*jsonb_array_length(names))); $$;
create function vc_test.walk_in(actor text,session text,request text,names jsonb) returns jsonb language sql as $$
select public.session_walk_in(vc_test.u(actor),jsonb_build_object('session_id',vc_test.sid(session),'request_id',vc_test.k(request),
  'participants',names,'expected_total_centavos',25000*jsonb_array_length(names))); $$;
create function vc_test.cancel(actor text,kind text,booking uuid,reason text) returns jsonb language sql as $$
select public.owner_booking_cancel(vc_test.u(actor),kind,booking,reason); $$;
create function vc_test.events(target uuid) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_object_agg(action,n),'{}') from (select action,count(*) n from (select action from private.rental_events where booking_id=target
  union all select action from private.session_booking_events where booking_id=target) e group by action) x; $$;
-- The outbox rows written for a booking's cancel event.
create function vc_test.alerts(target uuid) returns jsonb language sql security definer set search_path='' as $$
select coalesce(jsonb_agg(jsonb_build_object('to',o.recipient_user_id,'kind',o.kind,'audience',o.payload->>'audience','reason',o.payload->'reason')
  order by o.recipient_user_id),'[]') from private.notification_outbox o
where (o.source='rental' and o.event_id in (select e.id from private.rental_events e where e.booking_id=target and e.action='cancel'))
  or (o.source='session' and o.event_id in (select e.id from private.session_booking_events e where e.booking_id=target and e.action='cancel')); $$;
create function vc_test.alert(recipient text,audience text,reason text) returns jsonb language sql as $$
select jsonb_build_object('to',vc_test.u(recipient),'kind','booking.cancelled','audience',audience,'reason',reason); $$;
create function vc_test.audit(target uuid) returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object('actor',c.actor_user_id,'reason',c.reason,'venue',c.venue_id,'session',c.session_id)
from private.booking_cancellations c where c.booking_id=target; $$;
create function vc_test.session_row(target uuid) returns jsonb language sql security definer set search_path='' as $$
select jsonb_build_object('status',s.status,'reserved',s.reserved_spots,'reason',s.cancel_reason,'by',s.cancelled_by)
from private.open_play_sessions s where s.id=target; $$;
-- Trusted SQL only: stand in for operator policy and for time passing until a booking starts.
create function vc_test.policy(confirmation text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(vc_test.v(),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=private.venue_policies.revision+1; $$;
create function vc_test.start_rental(request text) returns void language sql security definer as $$
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '90 minutes' where request_id=vc_test.k(request); $$;
create function vc_test.start_session(request text) returns void language plpgsql security definer as $$
begin
  alter table private.open_play_sessions disable trigger session_immutable;
  update private.open_play_sessions set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
    ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '90 minutes' where request_id=vc_test.k(request);
  alter table private.open_play_sessions enable trigger session_immutable;
end; $$;
grant usage on schema vc_test to anon,authenticated,service_role;
grant execute on all functions in schema vc_test to anon,authenticated,service_role;

-- u1 owns V1 (u5 joins later), u4 owns V2, u2/u3 players, u6 admin, u7 moderator.
insert into auth.users(id) select vc_test.u(n::text) from generate_series(1,7) n;
insert into private.account_roles(user_id,role) values (vc_test.u('6'),'admin'),(vc_test.u('7'),'moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (vc_test.v(),'Cancellation Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  ('ca200000-0000-4000-8000-000000000002','Other Fixture','Fixture','Cebu City','Cebu',10.3,123.9,'approved','verified');
insert into public.courts(id,venue_id,name,status) select vc_test.c(n::text),vc_test.v(),chr(64+n),'active' from generate_series(1,3) n;
insert into public.courts(id,venue_id,name,status) values (vc_test.c('4'),'ca200000-0000-4000-8000-000000000002','A','active');
insert into private.venue_owners(user_id,venue_id) values (vc_test.u('1'),vc_test.v()),(vc_test.u('4'),'ca200000-0000-4000-8000-000000000002');
select public.venue_schedule_save(vc_test.u('1'),vc_test.v(),null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
select public.push_device_register(vc_test.u(n),jsonb_build_object('token','ExponentPushToken[vc-'||n||']','platform','ios')) from unnest(array['1','2','3','5']) n;
-- Court A: player rentals R1 (10), R2 (11), R3 (13), R5 (14), R6 (15), R7 (16), owner entry E1 (12), empty session S3 (30).
-- Court B: instant session S1 (20) with group G1 (21) and walk-in W0 (22); session S4 (40) with group G4 (41).
select vc_test.assert_that(vc_test.rent('2','1','10',600,660)->'booking'->>'status'='confirmed','R1');
select vc_test.assert_that(vc_test.rent('2','1','11',720,780)->'booking'->>'status'='confirmed','R2');
select vc_test.assert_that(vc_test.entry('1','1','12',780,840,'Wei')->'booking'->>'status'='confirmed','E1');
select vc_test.assert_that(vc_test.rent('3','1','13',840,900)->'booking'->>'status'='confirmed','R3');
select vc_test.assert_that(vc_test.rent('3','1','14',960,1020)->'booking'->>'status'='confirmed','R5');
select vc_test.assert_that(vc_test.rent('2','1','15',1080,1140)->'booking'->>'status'='confirmed','R6');
select vc_test.assert_that(vc_test.rent('3','1','16',1320,1380)->'booking'->>'status'='confirmed','R7');
select vc_test.assert_that(vc_test.session('1','20','2',600,720)->>'outcome'='created','S1');
select vc_test.assert_that(vc_test.group_request('2','20','21','["Ana","Ben"]')->'booking'->>'status'='confirmed','G1');
select vc_test.assert_that(vc_test.walk_in('1','20','22','["Cy"]')->'booking'->>'status'='confirmed','W0');
select vc_test.assert_that(vc_test.session('1','30','1',1200,1260)->>'outcome'='created','S3');
select vc_test.assert_that(vc_test.session('1','40','2',900,960)->>'outcome'='created','S4');
select vc_test.assert_that(vc_test.group_request('3','40','41','["Dee"]')->'booking'->>'status'='confirmed','G4');
-- Approval policy for a while: pending R4 (17) on C; session S2 (50) on C with groups G2 (51, accepted), G3 (52, pending) and walk-in W1 (53).
select vc_test.policy('approval');
select vc_test.assert_that(vc_test.rent('3','3','17',600,660)->'booking'->>'status'='pending','R4');
select vc_test.assert_that(vc_test.session('1','50','3',900,1020)->>'outcome'='created','S2');
select vc_test.assert_that(vc_test.group_request('3','50','51','["Eve","Fay"]')->'booking'->>'status'='pending','G2 pending');
select vc_test.assert_that(public.session_booking_change(vc_test.u('1'),vc_test.gid('51'),'accept')->'booking'->>'status'='confirmed','G2');
select vc_test.assert_that(vc_test.group_request('2','50','52','["Gus"]')->'booking'->>'status'='pending','G3');
select vc_test.assert_that(vc_test.walk_in('1','50','53','["Hal","Ivy"]')->'booking'->>'status'='confirmed','W1');
select vc_test.policy('instant');

set local role service_role;
-- Input, kind and access: only a current owner of the booking's venue.
select vc_test.expect_error(format($q$select public.owner_booking_cancel(%s)$q$,args),'22023','invalid_input') from unnest(array[
  $a$vc_test.u('1'),'court',vc_test.rid('10'),'weather'$a$,$a$vc_test.u('1'),'rental',vc_test.rid('10'),'rain'$a$,
  $a$vc_test.u('1'),'rental',vc_test.rid('10'),null$a$,$a$vc_test.u('1'),'rental',null,'weather'$a$,$a$vc_test.u('1'),null,vc_test.rid('10'),'weather'$a$,
  $a$null,'rental',vc_test.rid('10'),'weather'$a$,$a$'ca100000-0000-4000-8000-000000000099','rental',vc_test.rid('10'),'weather'$a$]) args;
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.gid('21'),'weather')$q$,'P0002','booking_not_found');
select vc_test.expect_error($q$select vc_test.cancel('1','session',vc_test.rid('10'),'weather')$q$,'P0002','booking_not_found');
select vc_test.expect_error(format($q$select vc_test.cancel(%L,'rental',vc_test.rid('10'),'weather')$q$,n),'42501','not_owner') from unnest(array['2','3','4','6','7']) n;
select vc_test.expect_error(format($q$select vc_test.cancel(%L,'session',vc_test.gid('21'),'weather')$q$,n),'42501','not_owner') from unnest(array['2','4','6','7']) n;

-- A venue-cancelled rental: released, audited, one event, the player (never the acting owner) alerted with the reason.
select vc_test.assert_that((select r->>'outcome'='changed' and b->>'status'='cancelled' and b->'venue_cancellation'->>'reason'='weather'
    and b->'venue_cancellation'->>'cancelled_at' is not null and b->'allocation'->>'state'='released' and b->>'payment_status'='unpaid'
  from vc_test.cancel('1','rental',vc_test.rid('10'),'weather') r,lateral (select r->'booking' b) x),'venue cancels R1');
select vc_test.assert_that(vc_test.events(vc_test.rid('10'))='{"cancel":1,"request":1}','one cancel event');
select vc_test.assert_that(vc_test.audit(vc_test.rid('10'))=jsonb_build_object('actor',vc_test.u('1'),'reason','weather','venue',vc_test.v(),'session',null),'audit row');
select vc_test.assert_that(vc_test.alerts(vc_test.rid('10'))=jsonb_build_array(vc_test.alert('2','player','weather')),'player alerted with the reason');
-- Retries and a second owner converge on the first cancellation and reason.
reset role;
insert into private.venue_owners(user_id,venue_id) values (vc_test.u('5'),vc_test.v());
set local role service_role;
select vc_test.assert_that((select r->>'outcome'='existing' and r->'booking'->'venue_cancellation'->>'reason'='weather'
  from vc_test.cancel('5','rental',vc_test.rid('10'),'maintenance') r),'co-owner retry keeps the first reason');
select vc_test.assert_that(vc_test.cancel('1','rental',vc_test.rid('10'),'weather')->>'outcome'='existing','retry');
select vc_test.assert_that(vc_test.events(vc_test.rid('10'))='{"cancel":1,"request":1}' and jsonb_array_length(vc_test.alerts(vc_test.rid('10')))=1,'retries add nothing');
-- The player reads why; the court is free straight away; other bookings carry no venue cancellation.
select vc_test.assert_that(public.rental_booking_read(vc_test.u('2'),vc_test.rid('10'))->'booking'->'venue_cancellation'->>'reason'='weather','player reads the reason');
select vc_test.assert_that(vc_test.rent('3','1','18',600,660)->'booking'->>'status'='confirmed','released court rebooks');
select vc_test.assert_that(public.rental_booking_read(vc_test.u('3'),vc_test.rid('18'))->'booking'->'venue_cancellation'='null'::jsonb,'no venue cancellation elsewhere');

-- Only confirmed player bookings before the start.
select vc_test.assert_that(public.rental_booking_change(vc_test.u('2'),vc_test.rid('11'),'cancel')->'booking'->>'status'='cancelled','player cancels R2');
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('11'),'weather')$q$,'23514','invalid_transition');
select vc_test.assert_that(public.rental_booking_read(vc_test.u('2'),vc_test.rid('11'))->'booking'->'venue_cancellation'='null'::jsonb
  and vc_test.alerts(vc_test.rid('11'))=jsonb_build_array(vc_test.alert('1','owner',null),vc_test.alert('5','owner',null)),'player cancellation: owners hear, no reason');
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('12'),'weather')$q$,'23514','invalid_transition');
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('17'),'weather')$q$,'23514','invalid_transition');
select vc_test.assert_that(public.rental_booking_change(vc_test.u('1'),vc_test.rid('17'),'decline')->'booking'->>'status'='declined','pending is declined instead');
select vc_test.expect_error($q$select vc_test.cancel('1','session',vc_test.gid('52'),'weather')$q$,'23514','invalid_transition');
select vc_test.expect_error($q$select vc_test.cancel('1','session',vc_test.gid('22'),'weather')$q$,'23514','invalid_transition');
reset role;
select vc_test.start_rental('13');
set local role service_role;
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('13'),'weather')$q$,'23514','invalid_transition');
select vc_test.assert_that(public.booking_operation(vc_test.u('1'),'rental',vc_test.rid('13'),'check_in')->'booking'->'operations'->>'attendance'='checked_in','R3 checked in');
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('13'),'weather')$q$,'55000','payment_collected');
select vc_test.assert_that(vc_test.events(vc_test.rid('13'))='{"check_in":1,"request":1}','refusals write nothing');
-- Front-desk records on a future booking (only possible if a later rule allowed them) are refused too, never refunded.
reset role;
insert into private.booking_operations(booking_id,session_booking_id,payment_method,paid_centavos,paid_at) values(vc_test.gid('41'),vc_test.gid('41'),'cash',25000,now());
insert into private.booking_operations(booking_id,rental_booking_id,attendance,attendance_at) values(vc_test.rid('14'),vc_test.rid('14'),'no_show',now());
set local role service_role;
select vc_test.expect_error($q$select vc_test.cancel('1','session',vc_test.gid('41'),'weather')$q$,'55000','payment_collected');
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('1'),vc_test.sid('40'),'weather')$q$,'55000','payment_collected');
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('14'),'weather')$q$,'55000','payment_collected');
reset role;
delete from private.booking_operations where booking_id in (vc_test.gid('41'),vc_test.rid('14'));
set local role service_role;

-- A venue-cancelled group frees its spots; the walk-in stays; the player may book the session again.
select vc_test.assert_that((select r->>'outcome'='changed' and b->>'status'='cancelled' and b->'venue_cancellation'->>'reason'='venue_closed'
  from vc_test.cancel('1','session',vc_test.gid('21'),'venue_closed') r,lateral (select r->'booking' b) x),'venue cancels G1');
select vc_test.assert_that((vc_test.session_row(vc_test.sid('20'))->>'reserved')::integer=1,'G1 spots released, walk-in kept');
select vc_test.assert_that(vc_test.events(vc_test.gid('21'))='{"cancel":1,"request":1}','one group cancel event');
select vc_test.assert_that(vc_test.alerts(vc_test.gid('21'))=jsonb_build_array(vc_test.alert('2','player','venue_closed')),'group player alerted');
select vc_test.assert_that(vc_test.cancel('5','session',vc_test.gid('21'),'other')->'booking'->'venue_cancellation'->>'reason'='venue_closed','group retry');
select vc_test.assert_that(public.session_booking_read(vc_test.u('2'),'booking',vc_test.gid('21'))->'booking'->'venue_cancellation'->>'reason'='venue_closed','player reads it');
select vc_test.assert_that(vc_test.group_request('2','20','24','["Ana","Ben","Cat"]')->'booking'->>'status'='confirmed','player rebooks the session');
select vc_test.assert_that((vc_test.session_row(vc_test.sid('20'))->>'reserved')::integer=4,'counter follows');
select vc_test.assert_that(vc_test.cancel('1','session',vc_test.gid('41'),'schedule_conflict')->'booking'->>'status'='cancelled','G4 once its records are gone');
select vc_test.assert_that(vc_test.cancel('1','rental',vc_test.rid('14'),'maintenance')->'booking'->>'status'='cancelled','R5 once its records are gone');

-- Occupied sessions need a reason (refused as before without one); every live group and walk-in is cancelled, every court released and the counter zeroed.
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('1'),vc_test.sid('50'))$q$,'55000','session_has_bookings');
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('1'),vc_test.sid('50'),'rain')$q$,'22023','invalid_input');
select vc_test.expect_error(format($q$select public.owner_session_cancel(vc_test.u(%L),vc_test.sid('50'),'maintenance')$q$,n),'42501','not_owner')
  from unnest(array['2','3','4','6','7']) n;
select vc_test.assert_that((select r->>'outcome'='cancelled' and r->'session'->>'status'='cancelled' and r->'session'->>'cancel_reason'='maintenance'
    and (r->'session'->>'reserved_spots')::integer=0 and not exists(select 1 from jsonb_array_elements(r->'session'->'allocations') a where a->>'state'<>'released')
  from public.owner_session_cancel(vc_test.u('1'),vc_test.sid('50'),'maintenance') r),'S2 cancelled');
reset role;
select vc_test.assert_that(vc_test.session_row(vc_test.sid('50'))=jsonb_build_object('status','cancelled','reserved',0,'reason','maintenance','by',vc_test.u('1')),'session record');
select vc_test.assert_that((select array_agg(status order by id)=array['cancelled','cancelled','cancelled'] from private.session_bookings where session_id=vc_test.sid('50')),'every booking cancelled');
select vc_test.assert_that((select count(*)=3 and bool_and(c.session_id=vc_test.sid('50') and c.reason='maintenance' and c.actor_user_id=vc_test.u('1'))
  from private.booking_cancellations c join private.session_bookings b on b.id=c.session_booking_id where b.session_id=vc_test.sid('50')),'one audit row each');
select vc_test.assert_that((select count(*) from private.directory_audit_events where action='session.cancel' and target_venue_id=vc_test.v())=1,'session audit');
set local role service_role;
select vc_test.assert_that(vc_test.events(vc_test.gid('51'))='{"accept":1,"cancel":1,"request":1}' and vc_test.events(vc_test.gid('52'))='{"cancel":1,"request":1}'
  and vc_test.events(vc_test.gid('53'))='{"cancel":1,"walk_in":1}','one cancel event per booking');
select vc_test.assert_that(vc_test.alerts(vc_test.gid('51'))=jsonb_build_array(vc_test.alert('3','player','maintenance'))
  and vc_test.alerts(vc_test.gid('52'))=jsonb_build_array(vc_test.alert('2','player','maintenance')) and vc_test.alerts(vc_test.gid('53'))='[]','each player group alerted once, walk-ins none');
select vc_test.assert_that(public.owner_session_cancel(vc_test.u('5'),vc_test.sid('50'),'weather')->>'outcome'='existing'
  and vc_test.events(vc_test.gid('51'))='{"accept":1,"cancel":1,"request":1}','session retry');
select vc_test.assert_that(vc_test.cancel('1','session',vc_test.gid('51'),'weather')->'booking'->'venue_cancellation'->>'reason'='maintenance','booking retry after the session');
select vc_test.assert_that(public.session_booking_read(vc_test.u('3'),'booking',vc_test.gid('51'))->'booking'->'venue_cancellation'->>'reason'='maintenance','player reads the session reason');
select vc_test.assert_that(vc_test.rent('2','3','19',900,960)->'booking'->>'status'='confirmed','released session court rebooks');
-- Empty sessions still cancel without a reason; started sessions and their groups cannot.
select vc_test.assert_that((select r->>'outcome'='cancelled' and r->'session'->'cancel_reason'='null'::jsonb
  from public.owner_session_cancel(vc_test.u('1'),vc_test.sid('30')) r),'empty session cancels without a reason');
reset role;
select vc_test.assert_that(vc_test.session_row(vc_test.sid('30'))->>'by'=vc_test.u('1')::text,'canceller recorded');
select vc_test.start_session('20');
set local role service_role;
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('1'),vc_test.sid('20'),'weather')$q$,'55000','session_started');
select vc_test.expect_error($q$select vc_test.cancel('1','session',vc_test.gid('24'),'weather')$q$,'23514','invalid_transition');

-- A moderation suspension leaves cancellation open; a revoked owner loses it.
reset role;
update public.venues set publication_status='suspended' where id=vc_test.v();
set local role service_role;
select vc_test.assert_that(vc_test.cancel('5','rental',vc_test.rid('15'),'other')->'booking'->>'status'='cancelled','cancels while suspended');
reset role;
update public.venues set publication_status='approved' where id=vc_test.v();
delete from private.venue_owners where user_id=vc_test.u('1');
set local role service_role;
select vc_test.expect_error($q$select vc_test.cancel('1','rental',vc_test.rid('16'),'weather')$q$,'42501','not_owner');
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('1'),vc_test.sid('40'),'weather')$q$,'42501','not_owner');
-- An event failure rolls the whole cancellation back.
reset role;
create function vc_test.fail_event() returns trigger language plpgsql as $$ begin if new.action='cancel' then raise exception 'event failure'; end if; return new; end; $$;
create trigger vc_fail_event before insert on private.rental_events for each row execute function vc_test.fail_event();
set local role service_role;
select vc_test.expect_error($q$select vc_test.cancel('5','rental',vc_test.rid('16'),'player_request')$q$,'P0001');
reset role;
select vc_test.assert_that((select b.status='confirmed' and a.state='active' from private.rental_bookings b join private.court_allocations a on a.id=b.id
  where b.id=vc_test.rid('16')) and not exists(select 1 from private.booking_cancellations where booking_id=vc_test.rid('16')),'event failure rolls back');
drop trigger vc_fail_event on private.rental_events;
set local role service_role;
select vc_test.assert_that(vc_test.cancel('5','rental',vc_test.rid('16'),'player_request')->'booking'->'venue_cancellation'->>'reason'='player_request','then succeeds');
-- Records are immutable, even for trusted SQL; a scheduled session carries no cancellation.
reset role;
select vc_test.expect_error($q$update private.booking_cancellations set reason='other' where booking_id=vc_test.rid('10')$q$,'23514','immutable_snapshot');
select vc_test.expect_error($q$update private.open_play_sessions set cancel_reason='other' where id=vc_test.sid('50')$q$,'55000','immutable_session');
select vc_test.expect_error($q$update private.open_play_sessions set cancelled_by=null where id=vc_test.sid('50')$q$,'55000','immutable_session');
select vc_test.expect_error($q$update private.open_play_sessions set cancel_reason='other' where id=vc_test.sid('40')$q$,'23514');
select vc_test.expect_error($q$insert into private.booking_cancellations(booking_id,rental_booking_id,session_booking_id,venue_id,actor_user_id,reason)
  values(vc_test.rid('19'),vc_test.rid('19'),vc_test.gid('24'),vc_test.v(),vc_test.u('5'),'other')$q$,'23514');
-- API roles reach nothing directly.
set local role authenticated;
select vc_test.expect_error($q$select vc_test.cancel('5','rental',vc_test.rid('19'),'weather')$q$,'42501');
select vc_test.expect_error($q$select public.owner_session_cancel(vc_test.u('5'),vc_test.sid('40'),'weather')$q$,'42501');
select vc_test.expect_error($q$select * from private.booking_cancellations$q$,'42501');
reset role;
rollback;
