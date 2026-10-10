-- Rollback-only T45 fixtures: account-wide alert topics. Strict save/read for the verified
-- caller, the topic of every audience/kind pair, outbox filtering per recipient (co-owners,
-- players, reminders, payments), deletion guards and the Auth cascade.
begin;
create schema ap;
create function ap.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Preference assertion failed: %',message; end if; end; $$;
create function ap.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function ap.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function ap.u(n text) returns uuid language sql immutable as $$ select ('c4b10000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ap.v() returns uuid language sql immutable as $$ select 'c4b20000-0000-4000-8000-000000000001'::uuid; $$;
create function ap.c(n text) returns uuid language sql immutable as $$ select ('c4b30000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function ap.save(actor text,muted jsonb) returns jsonb language sql as $$
select public.notification_preferences_save(ap.u(actor),jsonb_build_object('muted',muted)); $$;
create function ap.read(actor text) returns jsonb language sql as $$ select public.notification_preferences_read(ap.u(actor)); $$;
create function ap.rent(actor text,court text,a integer) returns uuid language sql as $$
select (public.rental_booking_request(ap.u(actor),ap.c(court),gen_random_uuid(),ap.at(a),ap.at(a+60),
  public.rental_booking_quote(ap.u(actor),ap.c(court),ap.at(a),ap.at(a+60))->'expected_quote')->'booking'->>'id')::uuid; $$;
create function ap.change(actor text,booking uuid,command text) returns text language sql as $$
select public.rental_booking_change(ap.u(actor),booking,command)->'booking'->>'status'; $$;
-- "kind>uN" for every outbox row of a booking, in a stable order.
create function ap.rows(booking uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(o.kind||'>u'||right(o.recipient_user_id::text,1),',' order by o.kind,o.recipient_user_id),'')
from private.notification_outbox o where o.payload->>'booking_id'=booking::text; $$;
create function ap.reminded(booking uuid) returns boolean language sql security definer set search_path='' as $$
select exists (select 1 from private.booking_reminders r where r.rental_booking_id=booking); $$;
create function ap.sweep(at_time timestamptz) returns integer language sql security definer set search_path='' as $$
select private.booking_reminders_enqueue(at_time,200); $$;
create function ap.stored(actor text) returns text language sql security definer set search_path='' as $$
select coalesce((select array_to_string(p.muted,',') from private.notification_preferences p where p.user_id=ap.u(actor)),'<none>'); $$;
create function ap.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(ap.v(),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
grant usage on schema ap to anon,authenticated,service_role;
grant execute on all functions in schema ap to anon,authenticated,service_role;

-- Every audience/kind pair the outbox writes has exactly one topic; nothing else has one.
select ap.assert_that(string_agg(a||' '||k||'='||coalesce(private.notification_topic(a,k),'-'),',' order by a,k)=
  'owner booking.accepted=-,owner booking.cancelled=bookings,owner booking.created=bookings,owner booking.declined=-,owner booking.expired=-,'
  ||'owner booking.reminder=-,owner booking.requested=requests,owner payment.recorded=-,'
  ||'player booking.accepted=updates,player booking.cancelled=updates,player booking.created=-,player booking.declined=updates,'
  ||'player booking.expired=updates,player booking.reminder=reminders,player booking.requested=-,player payment.recorded=payments',
  'topic map: '||string_agg(a||' '||k||'='||coalesce(private.notification_topic(a,k),'-'),',' order by a,k))
from (values ('owner'),('player')) x(a) cross join (values ('booking.requested'),('booking.created'),('booking.accepted'),('booking.declined'),
  ('booking.expired'),('booking.cancelled'),('payment.recorded'),('booking.reminder')) y(k);

-- u1 and u6 own the venue; u2 and u4 are players with phones; u3 has no row yet; u9 is deleting.
insert into auth.users(id) select ap.u(n::text) from generate_series(1,9) n;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (ap.v(),'Preference Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) select ap.c(n::text),ap.v(),chr(64+n),'active' from generate_series(1,6) n;
insert into private.venue_owners(user_id,venue_id) values (ap.u('1'),ap.v()),(ap.u('6'),ap.v());
select public.venue_schedule_save(ap.u('1'),ap.v(),null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));
select ap.policy('approval');

set local role service_role;
select public.push_device_register(ap.u(n),jsonb_build_object('token','ExponentPushToken[pref-'||n||']','platform','ios')) from unnest(array['1','6','2','4']) n;

-- Reading: nothing stored means nothing muted.
select ap.assert_that(ap.read('2')='{"muted":[]}' and ap.stored('2')='<none>','default: every topic on');
-- Saving: strict input, stored sorted and distinct, the whole set replaced each time.
select ap.expect_error(format($q$select public.notification_preferences_save(%L,%L)$q$,ap.u('2'),x.input),'22023','invalid_request')
from (values ('{}'::jsonb),('[]'),('"x"'),('{"muted":"updates"}'),('{"muted":null}'),('{"muted":["sms"]}'),('{"muted":["Updates"]}'),
  ('{"muted":["updates","updates"]}'),('{"muted":[1]}'),('{"muted":[null]}'),('{"muted":[],"user_id":"x"}'),('{"muted":[["updates"]]}'),
  ('{"muted":["bookings","payments","reminders","requests","updates","updates"]}')) x(input);
select ap.expect_error($q$select public.notification_preferences_save(null,'{"muted":[]}')$q$,'22023','invalid_request');
select ap.expect_error($q$select public.notification_preferences_read(null)$q$,'22023','invalid_request');
select ap.expect_error(format($q$select public.notification_preferences_save(%L,'{"muted":[]}')$q$,'c4b10000-0000-4000-8000-00000000000f'),'P0002','account_required');
select ap.assert_that(ap.stored('2')='<none>','refused saves store nothing');
select ap.assert_that(ap.save('2','["updates","reminders"]')='{"muted":["reminders","updates"]}','saved sorted');
select ap.assert_that(ap.read('2')='{"muted":["reminders","updates"]}' and ap.stored('2')='reminders,updates','read back');
select ap.assert_that(ap.save('2','["reminders","updates"]')='{"muted":["reminders","updates"]}','retry: same answer');
select ap.assert_that(ap.save('2','["updates","requests","payments","bookings","reminders"]')='{"muted":["bookings","payments","reminders","requests","updates"]}',
  'all five');
-- One write per statement: Postgres may evaluate the operands of an AND in any order.
select ap.assert_that(ap.save('2','[]')='{"muted":[]}','emptied');
select ap.assert_that(ap.stored('2')='' and ap.read('2')='{"muted":[]}','row kept, nothing muted');
select ap.assert_that(ap.read('3')='{"muted":[]}' and ap.read('4')='{"muted":[]}','other accounts untouched');

-- Owners: u1 mutes requests; the co-owner still hears. A pending request reaches u6 only.
select ap.save('1','["requests"]');
select set_config('ap.r1',ap.rent('2','1',600)::text,true);
select ap.assert_that(ap.rows(current_setting('ap.r1')::uuid)='booking.requested>u6','muted owner skipped: '||ap.rows(current_setting('ap.r1')::uuid));
-- u2 mutes updates: the acceptance writes nothing for u2; reminders stay on.
select ap.save('2','["updates"]');
select ap.assert_that(ap.change('6',current_setting('ap.r1')::uuid,'accept')='confirmed','R1 accepted');
select ap.assert_that(ap.rows(current_setting('ap.r1')::uuid)='booking.requested>u6','no acceptance row for u2');
-- A player cancellation is an owner "bookings" alert: u6 mutes it, u1 (requests only) still hears.
select ap.save('6','["bookings"]');
select ap.assert_that(ap.change('2',current_setting('ap.r1')::uuid,'cancel')='cancelled','R1 cancelled');
select ap.assert_that(ap.rows(current_setting('ap.r1')::uuid)='booking.cancelled>u1,booking.requested>u6','cancel rows: '||ap.rows(current_setting('ap.r1')::uuid));
-- Unmuted again, the next booking's alerts arrive; a decline is an update for the player.
select ap.save('1','[]'); select ap.save('2','[]');
select set_config('ap.r2',ap.rent('2','2',600)::text,true);
select ap.assert_that(ap.change('1',current_setting('ap.r2')::uuid,'decline')='declined','R2 declined');
select ap.assert_that(ap.rows(current_setting('ap.r2')::uuid)='booking.declined>u2,booking.requested>u1,booking.requested>u6','R2 rows: '||ap.rows(current_setting('ap.r2')::uuid));
-- Instant bookings are owner "bookings" alerts: u6 (muted bookings) gets nothing, u1 does.
reset role;
select ap.policy('instant');
set local role service_role;
select set_config('ap.r3',ap.rent('4','3',600)::text,true);
select ap.assert_that(ap.rows(current_setting('ap.r3')::uuid)='booking.created>u1','instant: '||ap.rows(current_setting('ap.r3')::uuid));

-- Reminders: u4 mutes them. The sweep still decides the booking once, so unmuting never resends it.
select ap.save('4','["reminders"]');
select ap.assert_that(ap.sweep(ap.at(570))>=1,'sweep');
select ap.assert_that(ap.reminded(current_setting('ap.r3')::uuid),'R3 reminder decided');
select ap.assert_that(ap.rows(current_setting('ap.r3')::uuid)='booking.created>u1','no reminder row for u4');
select ap.save('4','[]');
select ap.sweep(ap.at(575));
select ap.assert_that(ap.rows(current_setting('ap.r3')::uuid)='booking.created>u1','unmuting does not resend');
select set_config('ap.r4',ap.rent('4','4',600)::text,true);
select ap.assert_that(ap.sweep(ap.at(580))=1,'R4 reminded');
select ap.assert_that(ap.rows(current_setting('ap.r4')::uuid)='booking.created>u1,booking.reminder>u4','unmuted reminder sent');

-- Payments: u4 mutes payment records; the arrival payment writes nothing for u4.
select ap.save('4','["payments"]');
select set_config('ap.r5',ap.rent('4','5',1200)::text,true);
reset role;
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '30 minutes' where id=current_setting('ap.r5')::uuid;
set local role service_role;
select ap.assert_that(public.booking_operation(ap.u('1'),'rental',current_setting('ap.r5')::uuid,'check_in')->>'outcome'='changed','check-in');
select ap.assert_that(public.booking_operation(ap.u('1'),'rental',current_setting('ap.r5')::uuid,'record_payment','cash',40000)->>'outcome'='changed','payment');
select ap.assert_that(ap.rows(current_setting('ap.r5')::uuid)='booking.created>u1','no payment row for u4: '||ap.rows(current_setting('ap.r5')::uuid));
select ap.save('4','["updates"]');
select set_config('ap.r6',ap.rent('4','6',1200)::text,true);
reset role;
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '30 minutes' where id=current_setting('ap.r6')::uuid;
set local role service_role;
select public.booking_operation(ap.u('1'),'rental',current_setting('ap.r6')::uuid,'check_in');
select public.booking_operation(ap.u('1'),'rental',current_setting('ap.r6')::uuid,'record_payment','cash',40000);
select ap.assert_that(ap.rows(current_setting('ap.r6')::uuid)='booking.created>u1,payment.recorded>u4','other topics muted, payment sent');

-- Deletion in progress: no new row and no change to an existing one.
reset role;
insert into private.account_deletions(user_id) values (ap.u('9')),(ap.u('2'));
set local role service_role;
select ap.expect_error($q$select ap.save('9','["updates"]')$q$,'42501','account_deleted');
select ap.expect_error($q$select ap.save('2','["updates"]')$q$,'42501','account_deleted');
select ap.assert_that(ap.stored('9')='<none>' and ap.stored('2')='','deleting accounts unchanged');
reset role;
select ap.expect_error(format($q$insert into private.notification_preferences(user_id,muted) values (%L,'{updates}')$q$,ap.u('9')),'42501','account_deleted');
delete from private.account_deletions where user_id in (ap.u('9'),ap.u('2'));
-- Trusted SQL cannot store an unknown topic either.
select ap.expect_error(format($q$insert into private.notification_preferences(user_id,muted) values (%L,'{sms}')$q$,ap.u('3')),'23514');

-- The account's switches go with it.
set local role service_role;
select ap.save('3','["payments"]');
reset role;
select ap.assert_that(ap.stored('3')='payments','u3 row present');
delete from auth.users where id=ap.u('3');
select ap.assert_that(ap.stored('3')='<none>' and ap.stored('4')='updates','cascade removes only that account''s row');

rollback;
