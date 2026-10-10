-- Rollback-only T43 fixtures: push device registration, the booking-event outbox and the
-- worker's claim/complete/receipt commands (leases, retries, invalid tokens, stale rows).
begin;
create schema nt;
create function nt.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Notification assertion failed: %',message; end if; end; $$;
create function nt.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function nt.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function nt.u(n text) returns uuid language sql immutable as $$ select ('c4910000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function nt.v(n text) returns uuid language sql immutable as $$ select ('c4920000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function nt.c(n text) returns uuid language sql immutable as $$ select ('c4930000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function nt.k(n text) returns uuid language sql immutable as $$ select ('c4950000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function nt.token(name text) returns text language sql immutable as $$ select 'ExponentPushToken['||name||']'; $$;
create function nt.reg(actor text,name text) returns jsonb language sql as $$
select public.push_device_register(nt.u(actor),jsonb_build_object('token',nt.token(name),'platform','ios')); $$;
create function nt.unreg(actor text,name text) returns jsonb language sql as $$
select public.push_device_unregister(nt.u(actor),jsonb_build_object('token',nt.token(name))); $$;
create function nt.quote(actor text,court text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_quote(nt.u(actor),nt.c(court),nt.at(a),nt.at(b))->'expected_quote'; $$;
create function nt.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(nt.u(actor),nt.c(court),nt.k(request),nt.at(a),nt.at(b),nt.quote(actor,court,a,b)); $$;
create function nt.session(request text,court text,a integer,b integer) returns jsonb language sql as $$
select public.owner_session_create(nt.u('1'),jsonb_build_object('venue_id',nt.v('1'),'request_id',nt.k(request),
  'court_ids',jsonb_build_array(nt.c(court)),'title','Notify play','starts_at',nt.at(a),'ends_at',nt.at(b),
  'capacity',8,'group_limit',4,'price_centavos',25000)); $$;
create function nt.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=nt.k(request); $$;
create function nt.group_input(session text,request text,names jsonb) returns jsonb language sql as $$
select jsonb_build_object('session_id',nt.sid(session),'request_id',nt.k(request),'participants',names,
  'expected_total_centavos',25000*jsonb_array_length(names)); $$;
create function nt.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=nt.k(request); $$;
create function nt.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=nt.k(request); $$;
-- "kind>uN" for every outbox row of a booking, in a stable order.
create function nt.rows(booking uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(o.kind||'>u'||right(o.recipient_user_id::text,1),',' order by o.kind,o.recipient_user_id),'')
from private.notification_outbox o where o.payload->>'booking_id'=booking::text; $$;
create function nt.row_id(booking uuid,kind text,recipient text) returns uuid language sql security definer set search_path='' as $$
select id from private.notification_outbox o where o.payload->>'booking_id'=booking::text and o.kind=row_id.kind and o.recipient_user_id=nt.u(recipient); $$;
create function nt.payload(id uuid) returns jsonb language sql security definer set search_path='' as $$
select payload from private.notification_outbox where notification_outbox.id=payload.id; $$;
create function nt.state(id uuid) returns text language sql security definer set search_path='' as $$
select status||':'||attempts||':'||coalesce(last_error,'-') from private.notification_outbox where notification_outbox.id=state.id; $$;
create function nt.devices(actor text) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(substr(token,19,length(token)-19)||case when disabled_at is null then '' else '!' end,',' order by token),'')
from private.push_devices where user_id=nt.u(actor); $$;
create function nt.device_id(name text) returns uuid language sql security definer set search_path='' as $$
select id from private.push_devices where token=nt.token(name); $$;
create function nt.outbox_count() returns integer language sql security definer set search_path='' as $$
select count(*)::integer from private.notification_outbox; $$;
create function nt.deliveries(id uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(substr(d.token,19,length(d.token)-19)||'='||coalesce(p.ticket_id,'-')||'/'||coalesce(p.receipt,'-'),',' order by d.token),'')
from private.push_deliveries p join private.push_devices d on d.id=p.device_id where p.outbox_id=deliveries.id; $$;
-- Trusted SQL stands in for time passing and for operator policy.
create function nt.due(id uuid) returns void language sql security definer set search_path='' as $$
update private.notification_outbox set next_attempt_at=clock_timestamp()-interval '1 second' where notification_outbox.id=due.id; $$;
create function nt.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(nt.v('1'),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
create table nt.claims(round integer not null,item jsonb not null);
create function nt.claim(round integer,batch integer default 100) returns jsonb language plpgsql as $$
declare reply jsonb;
begin
  reply:=public.push_outbox_claim(batch,120);
  insert into nt.claims select round,value from jsonb_array_elements(reply->'items');
  return reply;
end; $$;
create function nt.claimed(round integer,id uuid) returns jsonb language sql as $$
select item from nt.claims where claims.round=claimed.round and item->>'id'=claimed.id::text; $$;
-- Completes one claimed row: outcomes is a list of [token name, outcome, ticket or error].
create function nt.complete(round integer,id uuid,outcomes jsonb,retry_after integer default null) returns jsonb language sql as $$
select public.push_outbox_complete(jsonb_build_array(jsonb_build_object('id',id,'claim_id',nt.claimed(round,id)->>'claim_id',
  'deliveries',(select coalesce(jsonb_agg(case o->>1 when 'ok' then jsonb_build_object('device_id',nt.device_id(o->>0),'outcome','ok','ticket_id',o->2)
      when 'error' then jsonb_build_object('device_id',nt.device_id(o->>0),'outcome','error','error',o->>2)
      else jsonb_build_object('device_id',nt.device_id(o->>0),'outcome',o->>1) end),'[]') from jsonb_array_elements(outcomes) o))
  ||case when retry_after is null then '{}'::jsonb else jsonb_build_object('retry_after_seconds',retry_after) end)); $$;
grant usage on schema nt to anon,authenticated,service_role;
grant execute on all functions in schema nt to anon,authenticated,service_role;
grant select,insert on nt.claims to service_role;

-- Nothing due: the cron hook returns without calling the worker (no Vault or pg_net needed).
select nt.assert_that(private.push_dispatch_kick() is null,'kick is a no-op with nothing due');

-- u1 and u6 own V1; u1 and u2 own V2; u2, u3, u4, u5 and u8 are players.
insert into auth.users(id) select nt.u(n::text) from generate_series(1,8) n;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (nt.v('1'),'Notify Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  (nt.v('2'),'Second Notify Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select nt.c(n::text),nt.v('1'),chr(64+n),'active' from generate_series(1,3) n;
insert into public.courts(id,venue_id,name,status) values (nt.c('4'),nt.v('2'),'A','active');
insert into private.venue_owners(user_id,venue_id) values (nt.u('1'),nt.v('1')),(nt.u('6'),nt.v('1')),(nt.u('1'),nt.v('2')),(nt.u('2'),nt.v('2'));
select public.venue_schedule_save(nt.u('1'),v,null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb))
from (values (nt.v('1')),(nt.v('2'))) x(v);

set local role service_role;
-- Registration: strict input, idempotent, verified actor only.
select nt.assert_that(nt.reg('1','owner-one')='{"status":"registered"}','u1 registers');
select nt.assert_that(nt.reg('1','owner-one')='{"status":"registered"}' and nt.devices('1')='owner-one','retry keeps one row');
select nt.expect_error(format($q$select public.push_device_register(%L,%L)$q$,nt.u('1'),x.input),'22023','invalid_request')
from (values ('{"token":"ExponentPushToken[a]"}'::jsonb),('{"token":"ExponentPushToken[a]","platform":"ios","user_id":"x"}'),
  ('{"token":"ExponentPushToken[]","platform":"ios"}'),('{"token":"ExponentPushToken[a b]","platform":"ios"}'),
  ('{"token":"ExponentPushToken[a]]","platform":"ios"}'),('{"token":"apns-raw-token","platform":"ios"}'),
  ('{"token":"ExponentPushToken[a]","platform":"web"}'),('{"token":7,"platform":"ios"}'),('[]'),('"x"')) x(input);
select nt.expect_error(format($q$select public.push_device_register(%L,%L)$q$,'c4910000-0000-4000-8000-000000000009',
  '{"token":"ExponentPushToken[ghost]","platform":"ios"}'),'P0002','account_required');
select nt.expect_error($q$select public.push_device_register(null,'{"token":"ExponentPushToken[a]","platform":"ios"}')$q$,'22023','invalid_request');
select nt.assert_that(public.push_device_register(nt.u('1'),jsonb_build_object('token','ExpoPushToken[Az09_-:.+/=]','platform','android'))->>'status'='registered',
  'both Expo token prefixes and URL-safe characters');
select nt.assert_that(public.push_device_unregister(nt.u('1'),jsonb_build_object('token','ExpoPushToken[Az09_-:.+/=]'))='{"status":"removed"}'
  and nt.devices('1')='owner-one','own token removed');
select nt.reg('6','owner-six'); select nt.reg('2','player-a'); select nt.reg('2','player-b'); select nt.reg('4','player-four');
-- A token registered from another account moves there (new row); moving back works the same way.
select set_config('nt.moved',nt.device_id('player-four')::text,true);
select nt.reg('5','player-four');
select nt.assert_that(nt.devices('4')='' and nt.devices('5')='player-four' and nt.device_id('player-four')::text<>current_setting('nt.moved'),'token moved to u5 with a new id');
select nt.reg('4','player-four');
select nt.assert_that(nt.devices('4')='player-four' and nt.devices('5')='','token moved back');
-- Unregistering someone else's token answers the same and changes nothing.
select nt.assert_that(nt.unreg('2','owner-one')='{"status":"removed"}' and nt.devices('1')='owner-one','foreign token untouched');
-- An account keeps its ten most recently seen devices.
select nt.reg('8','cap-'||lpad(n::text,2,'0')) from generate_series(1,10) n;
select nt.assert_that(nt.devices('8')='cap-01,cap-02,cap-03,cap-04,cap-05,cap-06,cap-07,cap-08,cap-09,cap-10','ten kept');
reset role;
update private.push_devices set seen_at=now()-interval '1 hour'+substr(token,23,2)::integer*interval '1 minute' where user_id=nt.u('8');
set local role service_role;
select nt.reg('8','cap-11');
select nt.assert_that(nt.devices('8')='cap-02,cap-03,cap-04,cap-05,cap-06,cap-07,cap-08,cap-09,cap-10,cap-11','the eleventh evicts the least recently seen: '||nt.devices('8'));
select nt.reg('8','cap-02');
select nt.reg('8','cap-12');
select nt.assert_that(nt.devices('8')='cap-02,cap-04,cap-05,cap-06,cap-07,cap-08,cap-09,cap-10,cap-11,cap-12','a re-seen device survives eviction: '||nt.devices('8'));

-- Booking events. Approval policy: a pending rental request notifies both owners.
reset role;
select nt.policy('approval');
set local role service_role;
select nt.assert_that(nt.rent('2','1','10',600,660)->'booking'->>'status'='pending','R1 pending');
select nt.assert_that(nt.rows(nt.rid('10'))='booking.requested>u1,booking.requested>u6','R1 request rows: '||nt.rows(nt.rid('10')));
select nt.assert_that(nt.payload(nt.row_id(nt.rid('10'),'booking.requested','1'))=jsonb_build_object('audience','owner','booking_kind','rental',
  'booking_id',nt.rid('10'),'venue_id',nt.v('1'),'venue_name','Notify Fixture',
  'starts_at',to_char(nt.at(600) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')),'R1 payload '||nt.payload(nt.row_id(nt.rid('10'),'booking.requested','1'))::text);
-- A player without a device gets no row; owners still do.
select nt.assert_that(nt.rent('3','2','11',600,660)->'booking'->>'status'='pending','R2 pending (u3, no device)');
select nt.assert_that(public.rental_booking_change(nt.u('1'),nt.rid('10'),'accept')->'booking'->>'status'='confirmed','R1 accepted');
select nt.assert_that(public.rental_booking_change(nt.u('6'),nt.rid('11'),'decline')->'booking'->>'status'='declined','R2 declined');
select nt.assert_that(nt.rows(nt.rid('11'))='booking.requested>u1,booking.requested>u6','R2: no decline row for a player without a device');
select nt.assert_that(public.rental_booking_change(nt.u('2'),nt.rid('10'),'cancel')->'booking'->>'status'='cancelled','R1 cancelled by u2');
select nt.assert_that(nt.rows(nt.rid('10'))='booking.accepted>u2,booking.cancelled>u1,booking.cancelled>u6,booking.requested>u1,booking.requested>u6',
  'R1 rows: '||nt.rows(nt.rid('10')));
select nt.assert_that(nt.payload(nt.row_id(nt.rid('10'),'booking.accepted','2'))->>'audience'='player'
  and nt.payload(nt.row_id(nt.rid('10'),'booking.cancelled','6'))->>'audience'='owner','audiences');
-- The actor never hears about their own action: u2 co-owns V2 and books there.
select nt.assert_that(public.rental_booking_request(nt.u('2'),nt.c('4'),nt.k('12'),nt.at(600),nt.at(660),
  public.rental_booking_quote(nt.u('2'),nt.c('4'),nt.at(600),nt.at(660))->'expected_quote')->'booking'->>'status'='confirmed','R3 at V2');
select nt.assert_that(nt.rows(nt.rid('12'))='booking.created>u1','R3: only the other owner (instant = created): '||nt.rows(nt.rid('12')));
-- Owner entries notify nobody.
select nt.assert_that(public.rental_booking_owner_entry(nt.u('1'),nt.c('2'),nt.k('13'),nt.at(720),nt.at(780),'Walk-up guest',nt.quote('1','2',720,780))->'booking'->>'status'='confirmed','owner entry');
select nt.assert_that(public.rental_booking_change(nt.u('6'),nt.rid('13'),'cancel')->'booking'->>'status'='cancelled','co-owner cancels the entry');
select nt.assert_that(nt.rows(nt.rid('13'))='','owner entry and its cancellation: no rows');
-- An event that rolls back takes its rows with it.
select set_config('nt.before',nt.outbox_count()::text,true);
reset role;
select nt.expect_error(format($q$do $x$ begin insert into private.rental_events(booking_id,actor_user_id,action) values (%L,%L,'cancel');
  raise exception 'boom' using errcode='P0001'; end $x$$q$,nt.rid('11'),nt.u('3')),'P0001');
select nt.assert_that(nt.outbox_count()=current_setting('nt.before')::integer,'rolled-back event left no rows');
-- An elapsed hold's expiry (written by the T32 sweep with no actor) notifies the player.
set local role service_role;
select nt.assert_that(nt.rent('2','3','14',600,660)->'booking'->>'status'='pending','R5 pending');
reset role;
insert into private.rental_events(booking_id,actor_user_id,action) values (nt.rid('14'),null,'expire');
set local role service_role;
select nt.assert_that(nt.rows(nt.rid('14'))='booking.expired>u2,booking.requested>u1,booking.requested>u6','R5 expiry row: '||nt.rows(nt.rid('14')));

-- Open play. Approval: request, then a decline for the player.
select nt.assert_that(nt.session('01','2',840,960)->>'outcome'='created','approval session S1');
select nt.assert_that(public.session_booking_request(nt.u('2'),nt.group_input('01','20','["Ana","Ben"]'))->'booking'->>'status'='pending','G1 pending');
select nt.assert_that(public.session_booking_change(nt.u('1'),nt.gid('20'),'decline')->'booking'->>'status'='declined','G1 declined');
select nt.assert_that(nt.rows(nt.gid('20'))='booking.declined>u2,booking.requested>u1,booking.requested>u6','G1 rows: '||nt.rows(nt.gid('20')));
select nt.assert_that(nt.payload(nt.row_id(nt.gid('20'),'booking.declined','2'))->>'booking_kind'='group','group payload kind');
-- Walk-ins notify nobody.
select nt.assert_that(public.session_walk_in(nt.u('1'),nt.group_input('01','21','["Walk Lee"]'))->'booking'->>'status'='confirmed','walk-in');
select nt.assert_that(public.session_booking_change(nt.u('6'),nt.gid('21'),'cancel')->'booking'->>'status'='cancelled','co-owner removes the walk-in');
select nt.assert_that(nt.rows(nt.gid('21'))='','walk-in and its removal: no rows');
-- Instant: the request is a new booking for the owners; the player's cancellation notifies them.
reset role;
select nt.policy('instant');
set local role service_role;
select nt.assert_that(nt.session('02','3',1020,1140)->>'outcome'='created','instant session S2');
select nt.assert_that(public.session_booking_request(nt.u('4'),nt.group_input('02','22','["Cy"]'))->'booking'->>'status'='confirmed','G2 confirmed');
select nt.assert_that(public.session_booking_change(nt.u('4'),nt.gid('22'),'cancel')->'booking'->>'status'='cancelled','G2 cancelled');
select nt.assert_that(nt.rows(nt.gid('22'))='booking.cancelled>u1,booking.cancelled>u6,booking.created>u1,booking.created>u6','G2 rows: '||nt.rows(nt.gid('22')));

-- A recorded arrival payment notifies the player with the amount; attendance does not.
select nt.assert_that(nt.rent('2','3','15',1200,1260)->'booking'->>'status'='confirmed','R6 confirmed');
reset role;
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '30 minutes' where id=nt.rid('15');
set local role service_role;
select nt.assert_that(public.booking_operation(nt.u('1'),'rental',nt.rid('15'),'check_in')->>'outcome'='changed','check-in');
select nt.assert_that(public.booking_operation(nt.u('1'),'rental',nt.rid('15'),'record_payment','cash',40000)->>'outcome'='changed','payment');
select nt.assert_that(nt.rows(nt.rid('15'))='booking.created>u1,booking.created>u6,payment.recorded>u2','R6 rows: '||nt.rows(nt.rid('15')));
select nt.assert_that((nt.payload(nt.row_id(nt.rid('15'),'payment.recorded','2'))->>'amount_centavos')::bigint=40000,'payment amount');

-- Deletion in progress: no new device, no refresh of an existing one, and no rows for that account.
reset role;
insert into private.account_deletions(user_id) values (nt.u('6'));
set local role service_role;
select nt.expect_error($q$select nt.reg('6','owner-six')$q$,'42501','account_deleted');
select nt.expect_error($q$select nt.reg('6','owner-six-new')$q$,'42501','account_deleted');
select nt.assert_that(nt.rent('5','1','16',900,960)->'booking'->>'status'='confirmed','R7 (u5)');
select nt.assert_that(nt.rows(nt.rid('16'))='booking.created>u1','R7: deleting owner gets nothing: '||nt.rows(nt.rid('16')));
reset role;
delete from private.account_deletions where user_id=nt.u('6');
set local role service_role;

-- Worker. Claim leases every due row once; a second claim finds nothing.
select set_config('nt.claimed',jsonb_array_length(nt.claim(1)->'items')::text,true);
select nt.assert_that(current_setting('nt.claimed')::integer=nt.outbox_count() and nt.outbox_count()=22,'claimed every row:'||current_setting('nt.claimed'));
select nt.assert_that(jsonb_array_length(public.push_outbox_claim(100,120)->'items')=0,'leased rows are not claimed twice');
select set_config('nt.accepted',nt.row_id(nt.rid('10'),'booking.accepted','2')::text,true);
select nt.assert_that((select jsonb_agg(d order by d->>'token') from jsonb_array_elements(nt.claimed(1,current_setting('nt.accepted')::uuid)->'devices') d)
  =jsonb_build_array(jsonb_build_object('id',nt.device_id('player-a'),'token',nt.token('player-a')),jsonb_build_object('id',nt.device_id('player-b'),'token',nt.token('player-b')))
  and nt.claimed(1,current_setting('nt.accepted')::uuid)->>'kind'='booking.accepted'
  and nt.claimed(1,current_setting('nt.accepted')::uuid)->'payload'=nt.payload(current_setting('nt.accepted')::uuid),'claim shape');
-- One device accepted, one to retry: back to pending with backoff, ticket kept.
select nt.assert_that(nt.complete(1,current_setting('nt.accepted')::uuid,'[["player-a","ok","tkt-a"],["player-b","retry"]]')='{"completed":1,"stale":0}','partial');
select nt.assert_that(nt.state(current_setting('nt.accepted')::uuid)='pending:1:-' and nt.deliveries(current_setting('nt.accepted')::uuid)='player-a=tkt-a/-','partial state');
reset role;
select nt.assert_that((select next_attempt_at between clock_timestamp()+interval '29 seconds' and clock_timestamp()+interval '31 seconds'
  from private.notification_outbox where id=current_setting('nt.accepted')::uuid),'30 s backoff');
set local role service_role;
-- A reply for a claim that has finished changes nothing.
select nt.assert_that(nt.complete(1,current_setting('nt.accepted')::uuid,'[["player-b","ok","tkt-late"]]')='{"completed":0,"stale":1}','late reply stale');
select nt.assert_that(jsonb_array_length(public.push_outbox_claim(100,120)->'items')=0,'not due before the backoff');
-- When due again, only the device without a ticket is sent.
select nt.due(current_setting('nt.accepted')::uuid);
select nt.claim(2);
select nt.assert_that(nt.claimed(2,current_setting('nt.accepted')::uuid)->'devices'=jsonb_build_array(
  jsonb_build_object('id',nt.device_id('player-b'),'token',nt.token('player-b'))),'retry resends only the unsent device');
select nt.complete(2,current_setting('nt.accepted')::uuid,'[["player-b","ok","tkt-b"]]');
select nt.assert_that(nt.state(current_setting('nt.accepted')::uuid)='sent:2:-' and nt.deliveries(current_setting('nt.accepted')::uuid)='player-a=tkt-a/-,player-b=tkt-b/-','sent');

-- DeviceNotRegistered disables the token; with nothing delivered the row is dropped.
select set_config('nt.req',nt.row_id(nt.rid('10'),'booking.requested','1')::text,true);
select nt.complete(1,current_setting('nt.req')::uuid,'[["owner-one","invalid"]]');
select nt.assert_that(nt.state(current_setting('nt.req')::uuid)='dropped:1:no_devices' and nt.devices('1')='owner-one!','invalid token disabled, row dropped');
-- The app registering it again re-enables it.
select nt.reg('1','owner-one');
select nt.assert_that(nt.devices('1')='owner-one','re-registered token enabled');
-- A permanent Expo error fails the row with its code.
select set_config('nt.err',nt.row_id(nt.rid('10'),'booking.requested','6')::text,true);
select nt.complete(1,current_setting('nt.err')::uuid,'[["owner-six","error","message_too_big"]]');
select nt.assert_that(nt.state(current_setting('nt.err')::uuid)='failed:1:message_too_big','permanent error fails the row');
-- Retry-After from Expo stretches the backoff.
select set_config('nt.wait',nt.row_id(nt.rid('10'),'booking.cancelled','1')::text,true);
select nt.complete(1,current_setting('nt.wait')::uuid,'[["owner-one","retry"]]',600);
reset role;
select nt.assert_that((select next_attempt_at>=clock_timestamp()+interval '599 seconds' from private.notification_outbox where id=current_setting('nt.wait')::uuid),'Retry-After honoured');
set local role service_role;
-- Five attempts at most.
select set_config('nt.five',nt.row_id(nt.rid('12'),'booking.created','1')::text,true);
select nt.complete(1,current_setting('nt.five')::uuid,'[["owner-one","retry"]]');
do $$ begin
  for n in 1..3 loop
    perform nt.due(current_setting('nt.five')::uuid); perform nt.claim(10+n);
    perform nt.complete(10+n,current_setting('nt.five')::uuid,'[["owner-one","retry"]]');
  end loop;
end $$;
select nt.assert_that(nt.state(current_setting('nt.five')::uuid)='pending:4:-','four attempts so far: '||nt.state(current_setting('nt.five')::uuid));
select nt.due(current_setting('nt.five')::uuid); select nt.claim(20);
select nt.complete(20,current_setting('nt.five')::uuid,'[["owner-one","retry"]]');
select nt.assert_that(nt.state(current_setting('nt.five')::uuid)='failed:5:retries_exhausted','fifth retry gives up');

-- An expired lease is reclaimed with a new claim; the old worker's late reply changes nothing.
select set_config('nt.lease',nt.row_id(nt.gid('20'),'booking.declined','2')::text,true);
reset role;
update private.notification_outbox set locked_until=clock_timestamp()-interval '1 second' where id=current_setting('nt.lease')::uuid;
set local role service_role;
select nt.claim(30);
select nt.assert_that(nt.claimed(30,current_setting('nt.lease')::uuid)->>'claim_id'<>nt.claimed(1,current_setting('nt.lease')::uuid)->>'claim_id'
  and nt.state(current_setting('nt.lease')::uuid)='sending:2:-','lease reclaimed');
select nt.assert_that(nt.complete(1,current_setting('nt.lease')::uuid,'[["player-a","ok","tkt-old"]]')='{"completed":0,"stale":1}','old lease reply stale');
select nt.complete(30,current_setting('nt.lease')::uuid,'[["player-a","ok","tkt-lease-a"],["player-b","ok","tkt-lease-b"]]');
select nt.assert_that(nt.state(current_setting('nt.lease')::uuid)='sent:2:-' and nt.deliveries(current_setting('nt.lease')::uuid)='player-a=tkt-lease-a/-,player-b=tkt-lease-b/-','reclaimed row sent once');
-- A device that moved to another account after the claim is skipped.
select set_config('nt.move',nt.row_id(nt.gid('20'),'booking.requested','6')::text,true);
select nt.reg('5','owner-six');
select nt.complete(1,current_setting('nt.move')::uuid,'[["owner-six","ok","tkt-moved"]]');
select nt.assert_that(nt.state(current_setting('nt.move')::uuid)='dropped:1:no_devices' and nt.deliveries(current_setting('nt.move')::uuid)='','moved device skipped');
select nt.reg('6','owner-six');
-- An ok without a ticket id is delivered but has no receipt to fetch.
select set_config('nt.noticket',nt.row_id(nt.rid('15'),'payment.recorded','2')::text,true);
select public.push_outbox_complete(jsonb_build_array(jsonb_build_object('id',current_setting('nt.noticket')::uuid,
  'claim_id',nt.claimed(1,current_setting('nt.noticket')::uuid)->>'claim_id','deliveries',jsonb_build_array(
    jsonb_build_object('device_id',nt.device_id('player-a'),'outcome','ok','ticket_id',null),
    jsonb_build_object('device_id',nt.device_id('player-b'),'outcome','ok','ticket_id','tkt-pay-b')))));
select nt.assert_that(nt.state(current_setting('nt.noticket')::uuid)='sent:1:-' and nt.deliveries(current_setting('nt.noticket')::uuid)='player-a=-/unknown,player-b=tkt-pay-b/-','null ticket delivered');
-- Malformed completions are refused whole.
select nt.expect_error(format($q$select public.push_outbox_complete(%L)$q$,x.input),'22023','invalid_request')
from (values ('{}'::jsonb),(jsonb_build_array(jsonb_build_object('id','x','claim_id','y','deliveries','[]'::jsonb))),
  (jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'claim_id',gen_random_uuid(),'deliveries',jsonb_build_array(
    jsonb_build_object('device_id',gen_random_uuid(),'outcome','sent'))))),
  (jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'claim_id',gen_random_uuid(),'deliveries',jsonb_build_array(
    jsonb_build_object('device_id',gen_random_uuid(),'outcome','error','error','Bad Code'))))),
  (jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'claim_id',gen_random_uuid(),'deliveries',jsonb_build_array(
    jsonb_build_object('device_id',gen_random_uuid(),'outcome','ok','ticket_id','bad ticket'))))),
  (jsonb_build_array(jsonb_build_object('id',gen_random_uuid(),'claim_id',gen_random_uuid(),'deliveries','[]'::jsonb,'retry_after_seconds',99999)))) x(input);
select nt.expect_error($q$select public.push_outbox_claim(0,120)$q$,'22023','invalid_request');
select nt.expect_error($q$select public.push_outbox_claim(10,5)$q$,'22023','invalid_request');

-- Stale rows (six hours old) are dropped, not sent; rows for an account with no devices left are dropped.
reset role;
update private.notification_outbox set created_at=clock_timestamp()-interval '7 hours',locked_until=clock_timestamp()-interval '1 second'
  where id=nt.row_id(nt.rid('16'),'booking.created','1');
update private.push_devices set disabled_at=clock_timestamp() where user_id=nt.u('2');
update private.notification_outbox set locked_until=clock_timestamp()-interval '1 second' where id=nt.row_id(nt.rid('14'),'booking.expired','2');
set local role service_role;
select nt.claim(40);
select nt.assert_that(nt.claimed(40,nt.row_id(nt.rid('16'),'booking.created','1')) is null
  and nt.state(nt.row_id(nt.rid('16'),'booking.created','1'))='dropped:1:stale','stale row dropped');
select nt.assert_that(nt.claimed(40,nt.row_id(nt.rid('14'),'booking.expired','2')) is null
  and nt.state(nt.row_id(nt.rid('14'),'booking.expired','2'))='dropped:1:no_devices','no devices left: dropped');
select nt.reg('2','player-a'); select nt.reg('2','player-b');

-- Receipts: due 15 minutes after sending; ok, DeviceNotRegistered (disables the token) and errors record once.
select nt.assert_that(public.push_receipts_due(300)->'tickets'='[]','no receipts due yet');
reset role;
update private.push_deliveries set sent_at=now()-interval '16 minutes' where ticket_id in ('tkt-a','tkt-b','tkt-lease-a');
update private.push_deliveries set sent_at=now()-interval '25 hours' where ticket_id='tkt-pay-b';
set local role service_role;
select nt.assert_that(public.push_receipts_due(300)->'tickets'='["tkt-a", "tkt-b", "tkt-lease-a"]','due tickets: '||(public.push_receipts_due(300)->'tickets')::text);
select nt.assert_that(nt.deliveries(current_setting('nt.noticket')::uuid)='player-a=-/unknown,player-b=tkt-pay-b/unknown','a 25-hour-old ticket is unknown');
select nt.assert_that(public.push_receipts_record('[{"ticket_id":"tkt-a","outcome":"ok"},{"ticket_id":"tkt-b","outcome":"invalid"},
  {"ticket_id":"tkt-lease-a","outcome":"error","error":"message_rate_exceeded"},{"ticket_id":"tkt-unknown","outcome":"ok"}]')='{"recorded":3}','receipts recorded');
select nt.assert_that(nt.deliveries(current_setting('nt.accepted')::uuid)='player-a=tkt-a/ok,player-b=tkt-b/error' and nt.devices('2')='player-a,player-b!','receipt invalid disables the device');
select nt.assert_that(public.push_receipts_record('[{"ticket_id":"tkt-a","outcome":"invalid"}]')='{"recorded":0}' and nt.devices('2')='player-a,player-b!','receipt recorded once');
select nt.assert_that(public.push_receipts_due(300)->'tickets'='[]','nothing due after recording');
select nt.expect_error($q$select public.push_receipts_record('[{"ticket_id":"tkt a","outcome":"ok"}]')$q$,'22023','invalid_request');
select nt.expect_error($q$select public.push_receipts_record('[{"ticket_id":"tkt-a","outcome":"error","error":"DeviceNotRegistered"}]')$q$,'22023','invalid_request');

-- Housekeeping: finished rows and disabled devices older than 30 days go on the next claim.
reset role;
update private.notification_outbox set finished_at=clock_timestamp()-interval '31 days' where id=current_setting('nt.err')::uuid;
update private.push_devices set disabled_at=clock_timestamp()-interval '31 days' where token=nt.token('player-b');
set local role service_role;
select nt.claim(50);
select nt.assert_that(nt.state(current_setting('nt.err')::uuid) is null and nt.devices('2')='player-a','old row and disabled device pruned');

-- Account deletion (Auth cascade) removes the account's devices and its rows.
reset role;
delete from auth.users where id=nt.u('6');
select nt.assert_that(not exists(select 1 from private.push_devices where user_id=nt.u('6'))
  and not exists(select 1 from private.notification_outbox where recipient_user_id=nt.u('6')),'Auth deletion cascades');
rollback;
