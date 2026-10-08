-- Rollback-only T24 SQL acceptance, shared by PGlite and Docker.
begin;
create schema booking_test;
create function booking_test.expect_error(command text, expected_hint text) returns void language plpgsql as $$
declare actual text;
begin
  begin execute command;
  exception when others then
    get stacked diagnostics actual=pg_exception_hint;
    if actual=expected_hint or sqlstate=expected_hint then return; end if;
    raise exception 'Expected %, got % / %',expected_hint,sqlstate,actual;
  end;
  raise exception 'Expected failure: %',expected_hint;
end;
$$;
create function booking_test.at(minute integer) returns timestamptz language sql stable as $$
  select ((clock_timestamp() at time zone 'Asia/Manila')::date+2)::timestamp at time zone 'Asia/Manila'+minute*interval '1 minute';
$$;
create function booking_test.request(n integer,minute integer) returns jsonb language sql as $$
  select public.rental_booking_request('a1000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000001',
    ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,booking_test.at(minute),booking_test.at(minute+60),
    public.rental_booking_quote('a1000000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000001',
      booking_test.at(minute),booking_test.at(minute+60))->'expected_quote');
$$;
grant usage on schema booking_test to anon,authenticated,service_role;
grant execute on all functions in schema booking_test to anon,authenticated,service_role;
insert into auth.users(id) values ('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002'),
  ('a1000000-0000-4000-8000-000000000003');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
  values('a2000000-0000-4000-8000-000000000001','Booking Fixture','Fixture','Manila','Fixture',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) values
  ('a3000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','A','active'),
  ('a3000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','B','active');
insert into private.venue_owners(user_id,venue_id) values('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001');
select public.venue_schedule_save('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,
    'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',10001))))) from generate_series(1,7)), 'exceptions','[]'::jsonb));
set local role anon;
select booking_test.expect_error('select booking_test.request(1,60)','42501');
reset role;
set local role authenticated;
select booking_test.expect_error('select booking_test.request(1,60)','42501');
select booking_test.expect_error('select public.rental_booking_read(''a1000000-0000-4000-8000-000000000002'')','42501');
reset role;
set local role service_role;
select booking_test.request(1,60);
select booking_test.expect_error('select * from private.rental_bookings','42501');
select booking_test.expect_error('select * from private.rental_events','42501');
select booking_test.expect_error('select private.rental_quote(''a3000000-0000-4000-8000-000000000001'',booking_test.at(60),booking_test.at(120))','42501');
reset role;

do $$
<<lifecycle>>
declare result jsonb; original jsonb; pending jsonb; id uuid; quote jsonb; newer jsonb; n integer;
  owner uuid:='a1000000-0000-4000-8000-000000000001'; player uuid:='a1000000-0000-4000-8000-000000000002';
  stranger uuid:='a1000000-0000-4000-8000-000000000003'; venue uuid:='a2000000-0000-4000-8000-000000000001';
  court uuid:='a3000000-0000-4000-8000-000000000001';
begin
  result:=booking_test.request(1,60); original:=result->'booking'; id:=(original->>'id')::uuid;
  if result->>'outcome'<>'existing' or original->>'status'<>'confirmed' or original->'allocation'->>'expires_at' is not null
    or original->'snapshot'->>'total_centavos'<>'10001' then raise exception 'Instant arrival failed'; end if;
  perform booking_test.expect_error('select booking_test.request(1,120)','request_reused');
  perform booking_test.expect_error('select booking_test.request(2,90)','allocation_conflict');
  perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,''cancel'')',stranger,id),'not_player');
  perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,''accept'')',player,id),'not_owner');
  perform booking_test.expect_error(format('select public.rental_booking_read(%L,%L)',stranger,id),'not_owner');
  perform booking_test.expect_error(format('select public.rental_booking_read(%L,null,%L)',player,venue),'not_owner');
  result:=public.rental_booking_change(player,id,'cancel');
  if result->'booking'->>'status'<>'cancelled' or result->'booking'->'allocation'->>'state'<>'released' then raise exception 'Cancel failed'; end if;
  if public.rental_booking_change(player,id,'cancel')->>'outcome'<>'existing' then raise exception 'Cancel retry failed'; end if;
  if booking_test.request(1,60)->'booking'->'snapshot'<>original->'snapshot' then raise exception 'Retry repriced'; end if;
  perform booking_test.request(2,60); -- Cancel released the interval.

  -- Effective approval policy selects an authoritative capped hold.
  perform public.owner_venue_policy_save(owner,venue,'0','{"confirmation":"approval","payment":"arrival"}');
  result:=booking_test.request(3,180); pending:=result->'booking'; id:=(pending->>'id')::uuid;
  if pending->>'status'<>'pending' or (pending->'allocation'->>'expires_at')::timestamptz>clock_timestamp()+interval '2 hours'
    or (pending->'allocation'->>'expires_at')::timestamptz<=clock_timestamp() then raise exception 'Approval hold failed'; end if;
  if jsonb_array_length(public.rental_booking_read(owner,null,venue)->'bookings')<>1 then raise exception 'Owner requests failed'; end if;
  result:=public.rental_booking_change(owner,id,'accept');
  if result->'booking'->>'status'<>'confirmed' or result->'booking'->'allocation'->>'expires_at' is not null
    or result->'booking'->'snapshot'<>pending->'snapshot' then raise exception 'Acceptance changed snapshot/hold'; end if;
  if public.rental_booking_change(owner,id,'accept')->>'outcome'<>'existing' then raise exception 'Accept retry failed'; end if;
  perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,''decline'')',owner,id),'invalid_transition');
  result:=booking_test.request(4,270); id:=(result->'booking'->>'id')::uuid;
  if public.rental_booking_change(owner,id,'decline')->'booking'->>'status'<>'declined' then raise exception 'Decline failed'; end if;
  if public.rental_booking_change(owner,id,'decline')->>'outcome'<>'existing' then raise exception 'Decline retry failed'; end if;

  -- No cron: a read projects expiry; acceptance releases and records it, never confirms.
  result:=booking_test.request(5,360); id:=(result->'booking'->>'id')::uuid;
  update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where court_allocations.id=lifecycle.id;
  if public.rental_booking_read(player,id)->'booking'->>'status'<>'expired' then raise exception 'Read relied on cron'; end if;
  if public.rental_booking_change(owner,id,'accept')->'booking'->>'status'<>'expired' then raise exception 'Late accept revived'; end if;
  if booking_test.request(5,360)->'booking'->>'status'<>'expired' then raise exception 'Retry revived'; end if;
  perform booking_test.request(6,360);
  result:=booking_test.request(7,450); id:=(result->'booking'->>'id')::uuid;
  update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where court_allocations.id=lifecycle.id;
  perform booking_test.request(8,450); -- Acquisition expires the old allocation even without a booking sweep.
  if public.rental_booking_change(player,id,'expire')->'booking'->>'status'<>'expired' then raise exception 'Explicit expiry failed'; end if;
  if public.rental_booking_change(player,id,'expire')->>'outcome'<>'existing' then raise exception 'Expiry duplicated'; end if;

  -- Stale price/policy review refuses before creating inventory; original retries still work.
  quote:=public.rental_booking_quote(player,court,booking_test.at(540),booking_test.at(600));
  perform public.owner_venue_policy_save(owner,venue,'1','{"confirmation":"instant","payment":"arrival"}');
  perform booking_test.expect_error(format('select public.rental_booking_request(%L,%L,%L,%L,%L,%L)',player,court,
    'a4000000-0000-4000-8000-000000000009',booking_test.at(540),booking_test.at(600),quote->'expected_quote'),'stale_quote');
  if exists(select 1 from private.court_allocations where request_id='a4000000-0000-4000-8000-000000000009') then raise exception 'Stale quote wrote'; end if;
  if booking_test.request(3,180)->'booking'->'snapshot'<>pending->'snapshot' then raise exception 'Policy edit repriced retry'; end if;
  -- A synthetic activated online-only policy cannot silently become arrival.
  insert into private.venue_merchants(venue_id,active) values(venue,true);
  perform public.owner_venue_policy_save(owner,venue,'2','{"confirmation":"instant","payment":"online"}');
  perform booking_test.expect_error('select booking_test.request(9,540)','arrival_unavailable');
  update private.venue_merchants set active=false where venue_id=venue;
  newer:=booking_test.request(9,540);
  if newer->'booking'->'snapshot'->'policy'->>'payment'<>'arrival' then raise exception 'Effective merchant policy failed'; end if;

  -- Suspension stops new rentals and acceptance, preserves player cancellation and owner release.
  perform public.owner_venue_policy_save(owner,venue,'3','{"confirmation":"approval","payment":"arrival"}');
  result:=booking_test.request(10,630); id:=(result->'booking'->>'id')::uuid;
  update public.venues set publication_status='suspended' where venues.id=venue;
  perform booking_test.expect_error('select booking_test.request(11,720)','venue_unavailable');
  perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,''accept'')',owner,id),'venue_unavailable');
  if public.rental_booking_change(owner,id,'decline')->'booking'->>'status'<>'declined' then raise exception 'Suspended release failed'; end if;
  if public.rental_booking_change(player,(newer->'booking'->>'id')::uuid,'cancel')->'booking'->>'status'<>'cancelled' then raise exception 'Suspended cancel failed'; end if;
  update public.venues set publication_status='approved' where venues.id=venue;
  delete from private.venue_owners where venue_id=venue;
  perform booking_test.expect_error(format('select public.rental_booking_read(%L,null,%L)',owner,venue),'not_owner');
  perform booking_test.expect_error('select booking_test.request(11,720)','venue_unavailable');
  insert into private.venue_owners(user_id,venue_id) values(owner,venue);

  -- Short-future approval cap is exactly the start, not a full two hours.
  quote:=public.rental_booking_quote(player,'a3000000-0000-4000-8000-000000000002',
    to_timestamp(ceil(extract(epoch from clock_timestamp())/1800)*1800+1800),
    to_timestamp(ceil(extract(epoch from clock_timestamp())/1800)*1800+5400));
  result:=public.rental_booking_request(player,'a3000000-0000-4000-8000-000000000002','a4000000-0000-4000-8000-000000000012',
    (quote->>'starts_at')::timestamptz,(quote->>'ends_at')::timestamptz,quote->'expected_quote');
  if result->'booking'->'allocation'->>'expires_at'<>result->'booking'->'allocation'->>'starts_at' then raise exception 'Start cap failed'; end if;
  select count(*) into n from private.rental_events where action='request';
  if n<>11 then raise exception 'Unexpected request event count %',n; end if;
  if jsonb_array_length(public.rental_booking_read(stranger)->'bookings')<>0 then raise exception 'History leaked'; end if;
end;
$$;

-- Audit failure rolls back allocation, snapshot and booking together.
create function booking_test.fail_event() returns trigger language plpgsql as $$ begin raise exception 'Audit failure' using hint='test_audit_failure'; end $$;
create trigger booking_fail before insert on private.rental_events for each row execute function booking_test.fail_event();
select booking_test.expect_error('select booking_test.request(99,810)','test_audit_failure');
do $$ begin
  if exists(select 1 from private.court_allocations where request_id='a4000000-0000-4000-8000-000000000099') then raise exception 'Failed audit leaked inventory'; end if;
end $$;
drop trigger booking_fail on private.rental_events;
-- Bounded keyset pages with independent player/owner authorization.
do $$
declare n integer; first_page jsonb; second_page jsonb;
begin
  for n in 20..49 loop
    perform booking_test.request(n,900);
    perform public.rental_booking_change('a1000000-0000-4000-8000-000000000002',
      (booking_test.request(n,900)->'booking'->>'id')::uuid,'cancel');
  end loop;
  first_page:=public.rental_booking_read('a1000000-0000-4000-8000-000000000002');
  second_page:=public.rental_booking_read('a1000000-0000-4000-8000-000000000002',null,null,(first_page->>'next_cursor')::uuid);
  if jsonb_array_length(first_page->'bookings')<>25 or first_page->>'next_cursor' is null
    or jsonb_array_length(second_page->'bookings')<>16 or second_page->>'next_cursor' is not null then raise exception 'Pagination failed'; end if;
end;
$$;
-- T26: a lifecycle event failure must roll back status AND inventory, not only creation.
do $$
declare before_booking jsonb; target_id uuid; command_name text; n bigint;
  owner uuid:='a1000000-0000-4000-8000-000000000001';
  player uuid:='a1000000-0000-4000-8000-000000000002';
begin
  before_booking:=booking_test.request(100,1050)->'booking'; target_id:=(before_booking->>'id')::uuid;
  if before_booking->>'status'<>'pending' then raise exception 'Rollback fixture must be pending'; end if;
  execute 'create trigger booking_fail before insert on private.rental_events for each row execute function booking_test.fail_event()';
  foreach command_name in array array['accept','decline','cancel'] loop
    perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,%L)',
      case when command_name='cancel' then player else owner end,target_id,command_name),'test_audit_failure');
    if public.rental_booking_read(player,target_id)->'booking'<>before_booking then
      raise exception 'Failed % event changed booking/allocation/snapshot',command_name;
    end if;
  end loop;
  update private.court_allocations set expires_at=clock_timestamp()-interval '1 second' where court_allocations.id=target_id;
  perform booking_test.expect_error(format('select public.rental_booking_change(%L,%L,''expire'')',player,target_id),'test_audit_failure');
  if (select state from private.court_allocations where court_allocations.id=target_id)<>'active'
    or (select status from private.rental_bookings where rental_bookings.id=target_id)<>'pending' then
    raise exception 'Failed expiry event persisted a lifecycle mutation';
  end if;
  select count(*) into n from private.rental_events where booking_id=target_id;
  if n<>1 then raise exception 'Failed lifecycle event leaked'; end if;
  execute 'drop trigger booking_fail on private.rental_events';
  if public.rental_booking_change(player,target_id,'expire')->'booking'->>'status'<>'expired'
    or public.rental_booking_change(player,target_id,'expire')->>'outcome'<>'existing' then
    raise exception 'Expiry did not recover after event failure';
  end if;
  if booking_test.request(100,1050)->'booking'->'snapshot'<>before_booking->'snapshot' then
    raise exception 'Recovered expiry changed retry snapshot';
  end if;
  select count(*) into n from private.rental_events where booking_id=target_id and action='expire';
  if n<>1 then raise exception 'Recovered expiry duplicated event'; end if;
end;
$$;
rollback;
