-- Rollback-only T44 fixtures: one-hour reminders through the T43 outbox (window boundaries,
-- once per booking, statuses and sources), the worker's claim-time re-check and the cron hook.
begin;
create schema rm;
create function rm.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Reminder assertion failed: %',message; end if; end; $$;
create function rm.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
-- Tomorrow in Manila: every sweep below stays within two days of the real clock that stamps
-- reminders, so the two-day prune never fires by time of day.
create function rm.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+1)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function rm.u(n text) returns uuid language sql immutable as $$ select ('c4a10000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function rm.v() returns uuid language sql immutable as $$ select 'c4a20000-0000-4000-8000-000000000001'::uuid; $$;
create function rm.c(n text) returns uuid language sql immutable as $$ select ('c4a30000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function rm.k(n text) returns uuid language sql immutable as $$ select ('c4a50000-0000-4000-8000-0000000000'||n)::uuid; $$;
-- Bookings by label.
create table rm.b(label text primary key,id uuid not null unique);
create function rm.id(name text) returns uuid language sql stable as $$ select id from rm.b where label=name; $$;
create function rm.quote(actor text,court text,a integer) returns jsonb language sql as $$
select public.rental_booking_quote(rm.u(actor),rm.c(court),rm.at(a),rm.at(a+60))->'expected_quote'; $$;
create function rm.rent(label text,actor text,court text,a integer) returns text language plpgsql as $$
declare reply jsonb;
begin
  reply:=public.rental_booking_request(rm.u(actor),rm.c(court),gen_random_uuid(),rm.at(a),rm.at(a+60),rm.quote(actor,court,a));
  insert into rm.b values (label,(reply->'booking'->>'id')::uuid);
  return reply->'booking'->>'status';
end; $$;
create function rm.entry(label text,court text,a integer) returns text language plpgsql as $$
declare reply jsonb;
begin
  reply:=public.rental_booking_owner_entry(rm.u('1'),rm.c(court),gen_random_uuid(),rm.at(a),rm.at(a+60),'Walk-up guest',rm.quote('1',court,a));
  insert into rm.b values (label,(reply->'booking'->>'id')::uuid);
  return reply->'booking'->>'status';
end; $$;
create function rm.session(label text,court text,a integer,b integer) returns text language plpgsql as $$
declare reply jsonb; request uuid:=gen_random_uuid();
begin
  reply:=public.owner_session_create(rm.u('1'),jsonb_build_object('venue_id',rm.v(),'request_id',request,
    'court_ids',jsonb_build_array(rm.c(court)),'title','Reminder play','starts_at',rm.at(a),'ends_at',rm.at(b),
    'capacity',8,'group_limit',4,'price_centavos',25000));
  insert into rm.b select label,s from rm.session_id(request) s;
  return reply->>'outcome';
end; $$;
create function rm.session_id(request uuid) returns setof uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=request; $$;
create function rm.group_input(session text,names jsonb) returns jsonb language sql as $$
select jsonb_build_object('session_id',rm.id(session),'request_id',gen_random_uuid(),'participants',names,
  'expected_total_centavos',25000*jsonb_array_length(names)); $$;
create function rm.join(label text,actor text,session text,names jsonb) returns text language plpgsql as $$
declare reply jsonb;
begin
  reply:=case when actor='walk-in' then public.session_walk_in(rm.u('1'),rm.group_input(session,names))
    else public.session_booking_request(rm.u(actor),rm.group_input(session,names)) end;
  insert into rm.b values (label,(reply->'booking'->>'id')::uuid);
  return reply->'booking'->>'status';
end; $$;
create function rm.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(rm.v(),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
-- The private sweep and re-check, as the cron hook runs them.
create function rm.sweep(at_time timestamptz) returns integer language sql security definer set search_path='' as $$
select private.booking_reminders_enqueue(at_time,200); $$;
create function rm.due(name text,at_time timestamptz) returns boolean language sql security definer set search_path='' as $$
select private.booking_reminder_due((select r.id from private.booking_reminders r where rm.id(name) in (r.rental_booking_id,r.session_booking_id)),at_time); $$;
create function rm.reminded() returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(b.label,',' order by b.label),'') from private.booking_reminders r
join rm.b b on b.id in (r.rental_booking_id,r.session_booking_id); $$;
create function rm.queued() returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(b.label||'>u'||right(o.recipient_user_id::text,1),',' order by b.label),'') from private.notification_outbox o
join rm.b b on b.id::text=o.payload->>'booking_id' where o.source='reminder'; $$;
create function rm.row(name text) returns jsonb language sql security definer set search_path='' as $$
select to_jsonb(o) from private.notification_outbox o where o.source='reminder' and o.payload->>'booking_id'=rm.id(name)::text; $$;
create function rm.state(name text) returns text language sql security definer set search_path='' as $$
select o.status||':'||coalesce(o.last_error,'-') from private.notification_outbox o where o.source='reminder' and o.payload->>'booking_id'=rm.id(name)::text; $$;
create function rm.first_made() returns timestamptz language sql security definer set search_path='' as $$
select min(created_at) from private.booking_reminders; $$;
create table rm.claims(item jsonb not null);
create function rm.claimed(name text) returns jsonb language sql as $$
select item from rm.claims where item->>'id'=rm.row(name)->>'id'; $$;
grant usage on schema rm to anon,authenticated,service_role;
grant execute on all functions in schema rm to anon,authenticated,service_role;
grant select,insert on rm.b,rm.claims to service_role;

-- u1 owns the venue; u2, u4 and u5 are players with phones; u3 is a player without one.
insert into auth.users(id) select rm.u(n::text) from generate_series(1,5) n;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (rm.v(),'Reminder Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select rm.c(n::text),rm.v(),chr(64+n),'active' from generate_series(1,6) n;
insert into private.venue_owners(user_id,venue_id) values (rm.u('1'),rm.v());
select public.venue_schedule_save(rm.u('1'),rm.v(),null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
select rm.policy('instant');

-- The cron hook sweeps with the real clock before anything else. K (u3, no phone) is moved to
-- the next half hour after now + 1 minute, inside the hour: it is reminded, with nothing to send.
set local role service_role;
select rm.assert_that(rm.rent('K','3','6',1200)='confirmed','K confirmed');
reset role;
update private.court_allocations set starts_at=to_timestamp((floor(extract(epoch from clock_timestamp()+interval '1 minute')/1800)+1)*1800),
  ends_at=to_timestamp((floor(extract(epoch from clock_timestamp()+interval '1 minute')/1800)+3)*1800) where id=rm.id('K');
select rm.assert_that(private.push_dispatch_kick() is null,'kick: nothing to send');
select rm.assert_that(rm.reminded()='K' and rm.queued()='','the cron hook reminded K without an outbox row: '||rm.reminded());
select rm.expect_error($q$select private.booking_reminders_enqueue(null,10)$q$,'22023','invalid_request');
select rm.expect_error($q$select private.booking_reminders_enqueue(now(),0)$q$,'22023','invalid_request');

set local role service_role;
select public.push_device_register(rm.u(n),jsonb_build_object('token','ExponentPushToken[reminder-'||n||']','platform','ios')) from unnest(array['2','4','5']) n;
-- Instant rentals: A (u2), B (u3, no phone), C (cancelled), D (owner entry), H (u5), G (u2).
select rm.assert_that(rm.rent('A','2','1',600)='confirmed','A');
select rm.assert_that(rm.rent('B','3','2',600)='confirmed','B');
select rm.assert_that(rm.rent('C','2','3',600)='confirmed','C');
select rm.assert_that(public.rental_booking_change(rm.u('2'),rm.id('C'),'cancel')->'booking'->>'status'='cancelled','C cancelled');
select rm.assert_that(rm.entry('D','4',600)='confirmed','D owner entry');
select rm.assert_that(rm.rent('H','5','2',660)='confirmed','H');
select rm.assert_that(rm.rent('G','2','3',720)='confirmed','G');
-- Open play (instant): S1 at 840 with G1 (u4), walk-in W1 and G2 (u5, cancelled); S2 at 1020 with G4 (u5).
select rm.assert_that(rm.session('S1','5',840,960)='created' and rm.session('S2','5',1020,1140)='created','sessions');
select rm.assert_that(rm.join('G1','4','S1','["Ana","Ben"]')='confirmed','G1');
select rm.assert_that(rm.join('W1','walk-in','S1','["Walk Lee"]')='confirmed','W1');
select rm.assert_that(rm.join('G2','5','S1','["Cy"]')='confirmed','G2');
select rm.assert_that(public.session_booking_change(rm.u('5'),rm.id('G2'),'cancel')->'booking'->>'status'='cancelled','G2 cancelled');
select rm.assert_that(rm.join('G4','5','S2','["Di"]')='confirmed','G4');
-- Approval requests at 720: E (u2) stays pending, F (u4) is accepted inside the hour.
reset role;
select rm.policy('approval');
set local role service_role;
select rm.assert_that(rm.rent('E','2','1',720)='pending' and rm.rent('F','4','2',720)='pending','E and F pending');

-- The window is (sweep, sweep + 1 hour]: exactly an hour before is in, the start itself is out.
select rm.assert_that(rm.sweep(rm.at(540)-interval '1 millisecond')=0 and rm.reminded()='K','61 minutes before: nothing');
select rm.assert_that(rm.sweep(rm.at(540))=2 and rm.reminded()='A,B,K','exactly an hour before A and B: '||rm.reminded());
select rm.assert_that(rm.queued()='A>u2','only a player with a phone gets a row: '||rm.queued());
select rm.assert_that(rm.sweep(rm.at(540))=0 and rm.reminded()='A,B,K','a repeat sweep reminds nobody twice');
select rm.assert_that(rm.row('A')->>'kind'='booking.reminder' and rm.row('A')->>'status'='pending'
  and rm.row('A')->'payload'=jsonb_build_object('audience','player','booking_kind','rental','booking_id',rm.id('A'),'venue_id',rm.v(),
    'venue_name','Reminder Fixture','starts_at',to_char(rm.at(600) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),'A row: '||(rm.row('A')->'payload')::text);
-- Pending E and F, cancelled C and the owner entry D are never reminded; H is not reminded at its start.
select rm.assert_that(rm.sweep(rm.at(660))=1 and rm.reminded()='A,B,G,K','at H''s start only G (720) is due: '||rm.reminded());
select rm.assert_that(rm.sweep(rm.at(660)-interval '1 millisecond')=1 and rm.reminded()='A,B,G,H,K','a moment before its start H is due');
-- F confirmed inside the hour: reminded once on the next sweep.
select rm.assert_that(public.rental_booking_change(rm.u('1'),rm.id('F'),'accept')->'booking'->>'status'='confirmed','F accepted');
select rm.assert_that(rm.sweep(rm.at(690))=1 and rm.sweep(rm.at(690))=0 and rm.reminded()='A,B,F,G,H,K','F reminded once: '||rm.reminded());
-- Open play: the walk-in and the cancelled group are never reminded.
select rm.assert_that(rm.sweep(rm.at(780)-interval '1 millisecond')=0,'S1 just over an hour away');
select rm.assert_that(rm.sweep(rm.at(780))=1 and rm.reminded()='A,B,F,G,G1,H,K','S1: only G1');
select rm.assert_that(rm.sweep(rm.at(1020))=0 and rm.sweep(rm.at(1020)-interval '1 millisecond')=1 and rm.reminded()='A,B,F,G,G1,G4,H,K','S2 start boundary');
select rm.assert_that(rm.queued()='A>u2,F>u4,G>u2,G1>u4,G4>u5,H>u5','rows: '||rm.queued());
select rm.assert_that(rm.row('G4')->'payload'->>'booking_kind'='group' and rm.row('G4')->'payload'->>'starts_at'=to_char(rm.at(1020) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'group payload');

-- A reminder applies while its booking is confirmed and not started.
select rm.assert_that(rm.due('H',rm.at(660)-interval '1 millisecond') and not rm.due('H',rm.at(660)),'rental re-check boundary');
select rm.assert_that(rm.due('G4',rm.at(1020)-interval '1 millisecond') and not rm.due('G4',rm.at(1020)),'group re-check boundary');
-- G and G1 are cancelled after their reminders; A has started.
select rm.assert_that(public.rental_booking_change(rm.u('2'),rm.id('G'),'cancel')->'booking'->>'status'='cancelled','G cancelled');
select rm.assert_that(public.session_booking_change(rm.u('4'),rm.id('G1'),'cancel')->'booking'->>'status'='cancelled','G1 cancelled');
select rm.assert_that(not rm.due('G',rm.at(540)) and not rm.due('G1',rm.at(540)),'cancelled bookings are not due');
reset role;
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '90 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes' where id=rm.id('A');
set local role service_role;
-- The worker never sends those three; the rest are claimed with their recipient.
insert into rm.claims select value from jsonb_array_elements(public.push_outbox_claim(100,120)->'items');
select rm.assert_that(rm.state('A')='dropped:obsolete' and rm.state('G')='dropped:obsolete' and rm.state('G1')='dropped:obsolete'
  and rm.claimed('A') is null and rm.claimed('G') is null and rm.claimed('G1') is null,'started and cancelled reminders dropped');
select rm.assert_that(rm.state('F')='sending:-' and rm.state('G4')='sending:-' and rm.state('H')='sending:-','due reminders claimed');
select rm.assert_that(rm.claimed('H')->>'kind'='booking.reminder' and rm.claimed('H')->>'recipient'=rm.u('5')::text
  and rm.claimed('H')->'devices'->0->>'token'='ExponentPushToken[reminder-5]','claim names the recipient');
select rm.assert_that((select bool_and(item ? 'recipient') from rm.claims),'every claimed item names its recipient');

-- Reminders more than two days old are pruned; their bookings have long started.
select rm.assert_that(rm.sweep(rm.first_made()+interval '2 days')=0 and rm.reminded()='A,B,F,G,G1,G4,H,K','exactly two days old: kept');
select rm.assert_that(rm.sweep(now()+interval '3 days')=0 and rm.reminded()='','pruned');
rollback;
