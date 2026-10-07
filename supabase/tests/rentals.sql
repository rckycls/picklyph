-- Rollback-only suite, shared by embedded PostgreSQL and local Docker.
begin;
create schema rental_test;
create function rental_test.expect_error(command text, expected_hint text) returns void
language plpgsql as $$
declare actual text;
begin
  begin execute command;
  exception when others then
    get stacked diagnostics actual = pg_exception_hint;
    if actual = expected_hint or sqlstate = expected_hint then return; end if;
    raise exception 'Expected %, received % / %', expected_hint, sqlstate, actual;
  end;
  raise exception 'Expected failure: %', expected_hint;
end;
$$;
create function rental_test.at(minute integer) returns timestamptz language sql stable as $$
select ((clock_timestamp() at time zone 'Asia/Manila')::date + 2)::timestamp at time zone 'Asia/Manila' + minute * interval '1 minute';
$$;
create function rental_test.schedule(rate bigint) returns jsonb language sql immutable as $$
select jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,
  'rates',jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',720,'hourly_centavos',rate),
    jsonb_build_object('start_minute',720,'end_minute',1440,'hourly_centavos',rate+10000))))) from generate_series(1,7)), 'exceptions','[]'::jsonb);
$$;
create function rental_test.acquire(request_suffix integer, starts integer, ends integer) returns jsonb language sql as $$
select private.rental_acquire('91000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001',
  rental_test.at(starts),rental_test.at(ends),null,('94000000-0000-4000-8000-' || lpad(request_suffix::text,12,'0'))::uuid);
$$;
grant usage on schema rental_test to anon, authenticated, service_role;
grant execute on all functions in schema rental_test to anon, authenticated, service_role;
insert into auth.users(id) values ('91000000-0000-4000-8000-000000000001'),('91000000-0000-4000-8000-000000000002');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('92000000-0000-4000-8000-000000000001','Rental Fixture','Fixture','Manila','Fixture',14.6,121,'approved','verified');
insert into public.courts(id,venue_id,name,status) values
  ('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','Rental A','active');
insert into private.venue_owners(user_id,venue_id) values ('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001');
select public.venue_schedule_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',null,rental_test.schedule(10001));

-- All API roles, including service_role, cannot call the private transaction helpers.
set local role anon;
select rental_test.expect_error('select rental_test.acquire(1,690,780)','42501');
reset role;
set local role authenticated;
select rental_test.expect_error('select rental_test.acquire(1,690,780)','42501');
reset role;
set local role service_role;
select rental_test.expect_error('select rental_test.acquire(1,690,780)','42501');
select rental_test.expect_error('select * from private.rental_snapshots','42501');
reset role;

-- Exact deterministic rules, including a 60-day start whose END crosses the horizon.
select private.validate_rental_window('2027-01-01 00:00Z','2027-01-01 01:00Z','2026-11-02 00:00Z');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:00Z','2027-01-01 01:00Z','2026-11-01 23:59:59.999Z')$q$,'outside_horizon');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:00Z','2027-01-01 01:00Z','2027-01-01 00:00Z')$q$,'start_not_future');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:00Z','2027-01-01 00:59:59.999Z','2026-12-31 23:59Z')$q$,'minimum_duration');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:00Z','2027-01-01 01:00:00.001Z','2026-12-31 23:59Z')$q$,'duration_increment');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:01Z','2027-01-01 01:01Z','2026-12-31 23:59Z')$q$,'slot_alignment');
select rental_test.expect_error($q$select private.validate_rental_window('2027-01-01 00:00Z','2027-01-02 00:30Z','2026-12-31 23:59Z')$q$,'maximum_duration');
select rental_test.expect_error($q$select private.validate_rental_window('infinity','infinity',now())$q$,'invalid_time');

do $$
declare acquired jsonb; original jsonb; newer jsonb; allocation uuid;
begin
  acquired := rental_test.acquire(1,690,780); original := acquired->'snapshot'; allocation := (acquired->'allocation'->>'id')::uuid;
  if original->>'total_centavos' <> '25002' or original->>'schedule_revision' <> '1'
    or original->>'policy_revision' <> '0' or original->'policy'->>'confirmation' <> 'instant'
    or original->'policy'->>'payment' <> 'arrival' then raise exception 'Wrong original snapshot: %', original; end if;
  -- New rates and policy apply to new rentals only. Rates-only edits preserve hours.
  perform public.venue_schedule_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','1',rental_test.schedule(30001));
  perform public.owner_venue_policy_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','0','{"confirmation":"approval","payment":"arrival"}');
  newer := rental_test.acquire(2,810,870)->'snapshot';
  if newer->>'total_centavos' <> '40001' or newer->>'schedule_revision' <> '2'
    or newer->>'policy_revision' <> '1' or newer->'policy'->>'confirmation' <> 'approval' then raise exception 'Stale new snapshot'; end if;
  if rental_test.acquire(1,690,780)->'snapshot' <> original then raise exception 'Retry repriced'; end if;
  perform private.allocation_release(allocation);
  if rental_test.acquire(1,690,780)->'snapshot' <> original then raise exception 'Released retry changed'; end if;
  if (select snapshot from private.rental_snapshots where allocation_id=allocation) <> original then raise exception 'Stored snapshot changed'; end if;
  perform rental_test.expect_error(format('update private.rental_snapshots set snapshot=''{}'' where allocation_id=%L',allocation),'immutable_snapshot');
  perform rental_test.expect_error('select rental_test.acquire(1,690,810)','request_reused');
end;
$$;

-- Rental failures leave no inventory, even where the generic allocator would allow it.
select rental_test.expect_error('select rental_test.acquire(3,900,930)','minimum_duration');
select rental_test.expect_error($q$select private.rental_acquire('91000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001',
  rental_test.at(900)-interval '63 days',rental_test.at(960)-interval '63 days',null,'94000000-0000-4000-8000-000000000003')$q$,'invalid_input');
select rental_test.expect_error($q$select private.rental_acquire('91000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000001',
  rental_test.at(900)+interval '63 days',rental_test.at(960)+interval '63 days',null,'94000000-0000-4000-8000-000000000003')$q$,'outside_horizon');
select public.venue_schedule_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','2',rental_test.schedule(9007199254730991));
select rental_test.expect_error('select rental_test.acquire(3,900,990)','price_overflow');
do $$ begin
  if exists(select 1 from private.court_allocations where request_id='94000000-0000-4000-8000-000000000003') then raise exception 'Invalid rental leaked inventory'; end if;
end $$;

-- Inactive merchant produces effective arrival even for a previously online policy.
insert into private.venue_merchants(venue_id,active) values ('92000000-0000-4000-8000-000000000001',true);
select public.owner_venue_policy_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','1','{"confirmation":"approval","payment":"both"}');
update private.venue_merchants set active=false where venue_id='92000000-0000-4000-8000-000000000001';
select public.venue_schedule_save('91000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001','3',rental_test.schedule(0));
do $$ declare result jsonb; begin
  result := rental_test.acquire(4,0,60)->'snapshot';
  if result->'policy'->>'payment' <> 'arrival' or result->'policy'->>'merchant_active' <> 'false' or result->>'total_centavos' <> '0' then raise exception 'Effective policy/free price wrong'; end if;
end $$;

-- Court rules and dated closures narrow price coverage too; old snapshots survive.
select public.court_hours_save('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',null,
  jsonb_build_object('weekly',null,'closures',jsonb_build_array(((rental_test.at(0) at time zone 'Asia/Manila')::date+1)::text)));
select rental_test.expect_error('select rental_test.acquire(5,1410,1500)','outside_hours');
-- Remove closure; overnight snapshot includes both civil dates and rates.
select public.court_hours_save('91000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001','1','{"weekly":null,"closures":[]}');
do $$ declare result jsonb; begin
  result := rental_test.acquire(5,1410,1500)->'snapshot';
  if result->>'total_centavos' <> '5000' or jsonb_array_length(result->'bands') <> 2 or result->>'court_hours_revision' <> '2' then raise exception 'Overnight snapshot wrong'; end if;
end $$;
update public.venues set publication_status='draft' where id='92000000-0000-4000-8000-000000000001';
select rental_test.expect_error('select rental_test.acquire(6,1020,1080)','venue_unavailable');
update public.venues set publication_status='approved',claim_status='unclaimed' where id='92000000-0000-4000-8000-000000000001';
select rental_test.expect_error('select rental_test.acquire(6,1020,1080)','venue_unavailable');
update public.venues set claim_status='verified' where id='92000000-0000-4000-8000-000000000001';
delete from private.venue_owners where venue_id='92000000-0000-4000-8000-000000000001';
select rental_test.expect_error('select rental_test.acquire(6,1020,1080)','venue_unavailable');
do $$ begin
  if (select count(*) from private.rental_snapshots where snapshot->>'venue_id'='92000000-0000-4000-8000-000000000001') <> 4 then raise exception 'Unexpected snapshot count'; end if;
  if exists(select 1 from private.court_allocations where request_id='94000000-0000-4000-8000-000000000006') then raise exception 'Denied venue leaked inventory'; end if;
end $$;
rollback;
