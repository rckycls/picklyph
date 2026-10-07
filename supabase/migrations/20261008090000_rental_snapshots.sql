-- T23: private transaction foundation. No player RPC/hold endpoint until T24.
create table private.rental_snapshots (
  allocation_id uuid primary key references private.court_allocations(id) on delete cascade,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object')
);
alter table private.rental_snapshots enable row level security;
revoke all on private.rental_snapshots from public, anon, authenticated, service_role;

create function private.rental_snapshot_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Rental snapshots cannot change' using errcode = '23514', hint = 'immutable_snapshot';
end;
$$;
create trigger rental_snapshot_immutable before update on private.rental_snapshots
  for each row execute function private.rental_snapshot_immutable();

-- Deterministic T09 parity; only rental_snapshot_create supplies the authoritative clock.
create function private.validate_rental_window(starts timestamptz, ends timestamptz, at_time timestamptz) returns integer
language plpgsql immutable set search_path = '' as $$
begin
  if starts is null or ends is null or at_time is null or not isfinite(starts) or not isfinite(ends) or not isfinite(at_time) then
    raise exception 'Invalid rental time' using errcode = '22023', hint = 'invalid_time';
  end if;
  if starts <= at_time then raise exception 'Start must be future' using errcode = '22023', hint = 'start_not_future'; end if;
  -- Seconds, not session-zone calendar days (DST must not alter the rolling horizon).
  if extract(epoch from starts - at_time) > 5184000 then raise exception 'Outside horizon' using errcode = '22023', hint = 'outside_horizon'; end if;
  if ends - starts < interval '60 minutes' then raise exception 'Minimum one hour' using errcode = '22023', hint = 'minimum_duration'; end if;
  if mod(extract(epoch from ends - starts),1800) <> 0 then raise exception 'Use half hours' using errcode = '22023', hint = 'duration_increment'; end if;
  if ends - starts > interval '24 hours' then raise exception 'Maximum one day' using errcode = '22023', hint = 'maximum_duration'; end if;
  if mod(extract(epoch from starts),1800) <> 0 or mod(extract(epoch from ends),1800) <> 0 then
    raise exception 'Use half-hour marks' using errcode = '22023', hint = 'slot_alignment';
  end if;
  if starts < timestamptz '2000-01-01 00:00+08' or ends > timestamptz '2100-01-01 00:00+08' then
    raise exception 'Invalid rental time' using errcode = '22023', hint = 'invalid_time';
  end if;
  return (extract(epoch from ends - starts) / 60)::integer;
end;
$$;

create function private.rental_price(starts timestamptz, ends timestamptz, intervals jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare band jsonb; opens timestamptz; closes timestamptz; a timestamptz; b timestamptz;
  covered timestamptz := starts; previous_end timestamptz; cents numeric; minutes integer;
  numerator numeric := 0; total numeric; bands jsonb := '[]';
begin
  if starts is null or ends is null or not isfinite(starts) or not isfinite(ends)
    or ends <= starts or ends - starts > interval '24 hours'
    or mod(extract(epoch from starts),1800) <> 0 or mod(extract(epoch from ends),1800) <> 0
    or jsonb_typeof(intervals) is distinct from 'array' then
    raise exception 'Invalid price input' using errcode = '22023', hint = 'invalid_time';
  end if;
  for band in select value from jsonb_array_elements(intervals) loop
    if jsonb_typeof(band->'hourly_centavos') is distinct from 'number' then
      raise exception 'Invalid rate' using errcode = '22023', hint = 'invalid_rates';
    end if;
    cents := (band->>'hourly_centavos')::numeric;
    opens := (band->>'starts_at')::timestamptz; closes := (band->>'ends_at')::timestamptz;
    if opens is null or closes is null or not isfinite(opens) or not isfinite(closes) or opens >= closes
      or mod(extract(epoch from opens),1800) <> 0 or mod(extract(epoch from closes),1800) <> 0
      or opens < previous_end or cents < 0 or cents > 9007199254740991 or cents <> trunc(cents) then
      raise exception 'Invalid rate' using errcode = '22023', hint = 'invalid_rates';
    end if;
    previous_end := closes;
    a := greatest(starts,opens); b := least(ends,closes);
    if a >= b then continue; end if;
    if a <> covered then raise exception 'Incomplete price coverage' using errcode = '23514', hint = 'outside_hours'; end if;
    minutes := (extract(epoch from b - a) / 60)::integer;
    numerator := numerator + cents * minutes;
    bands := bands || jsonb_build_array(jsonb_build_object('starts_at',a,'ends_at',b,'hourly_centavos',cents,'duration_minutes',minutes));
    covered := b;
  end loop;
  if covered <> ends then raise exception 'Incomplete price coverage' using errcode = '23514', hint = 'outside_hours'; end if;
  total := floor((numerator + 30) / 60);
  if total > 9007199254740991 then raise exception 'Price overflow' using errcode = '22003', hint = 'price_overflow'; end if;
  return jsonb_build_object('currency','PHP','pricing','hourly_prorated_half_up_total_v1',
    'duration_minutes',extract(epoch from ends - starts) / 60,'total_centavos',total,'bands',bands);
end;
$$;

-- Locks match allocation_acquire and all schedule/policy editors. A snapshot belongs
-- to one allocation, not to a mutable quote. Repeated calls return the original.
create function private.rental_snapshot_create(target_allocation_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare allocation private.court_allocations; listing public.venues; court public.courts;
  saved jsonb; at_time timestamptz; effective_policy jsonb; schedule_revision text; court_revision text;
  first_date date; last_date date;
begin
  select a.* into allocation from private.court_allocations a where a.id = target_allocation_id;
  if not found or allocation.kind <> 'rental' then
    raise exception 'Rental allocation required' using errcode = '22023', hint = 'invalid_input';
  end if;
  select v.* into listing from public.venues v where v.id = allocation.venue_id for share;
  select c.* into court from public.courts c where c.id = allocation.court_id for no key update;
  select a.* into allocation from private.court_allocations a where a.id = target_allocation_id for update;
  if not found then raise exception 'Allocation unavailable' using errcode = 'P0002', hint = 'allocation_not_found'; end if;
  select s.snapshot into saved from private.rental_snapshots s where s.allocation_id = target_allocation_id;
  if found then return saved; end if;
  -- Trusted merchant activation also takes venue first, then merchant.
  perform 1 from private.venue_merchants m where m.venue_id = allocation.venue_id for share;
  at_time := clock_timestamp();
  perform private.validate_rental_window(allocation.starts_at,allocation.ends_at,at_time);
  if not private.allocation_live(allocation.state,allocation.expires_at,at_time) then
    raise exception 'Allocation ended' using errcode = '23514', hint = 'allocation_ended';
  end if;
  if listing.publication_status is distinct from 'approved' or listing.claim_status is distinct from 'verified'
    or not exists(select 1 from private.venue_owners o where o.venue_id = allocation.venue_id) then
    raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  if court.status is distinct from 'active' then raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable'; end if;
  if not exists(select 1 from auth.users u where u.id = allocation.requested_by) then
    raise exception 'Player required' using errcode = '42501', hint = 'player_required';
  end if;
  select s.revision::text into schedule_revision from private.venue_schedules s where s.venue_id = allocation.venue_id;
  if not found then raise exception 'Schedule required' using errcode = '23514', hint = 'outside_hours'; end if;
  select s.revision::text into court_revision from private.court_schedules s where s.court_id = allocation.court_id;
  first_date := (allocation.starts_at at time zone 'Asia/Manila')::date;
  last_date := ((allocation.ends_at - interval '1 microsecond') at time zone 'Asia/Manila')::date;
  saved := private.rental_price(allocation.starts_at,allocation.ends_at,
    private.resolve_court_hours(allocation.court_id,first_date,last_date-first_date+1));
  effective_policy := private.venue_policy_view(allocation.venue_id);
  saved := saved || jsonb_build_object('version',1,'allocation_id',allocation.id,'venue_id',allocation.venue_id,
    'court_id',allocation.court_id,'starts_at',allocation.starts_at,'ends_at',allocation.ends_at,'created_at',at_time,
    'schedule_revision',schedule_revision,'court_hours_revision',court_revision,'policy_revision',effective_policy->>'revision',
    'policy',(effective_policy - 'venue_id' - 'revision') || jsonb_build_object('player_refund_cutoff_hours',24,
      'approval_hold_minutes',120,'payment_hold_minutes',15));
  insert into private.rental_snapshots(allocation_id,snapshot) values(allocation.id,saved);
  return saved;
end;
$$;

-- T24 must call this from its guarded, authorized booking transaction, derive actor
-- from verified Auth, choose policy-specific expiry, and persist its lifecycle/audit.
-- Any failure rolls inventory AND snapshot back; generic T21 helpers remain private.
create function private.rental_acquire(actor_user_id uuid, target_court_id uuid, starts timestamptz,
  ends timestamptz, hold_until timestamptz, request uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare acquired jsonb; snapshot jsonb;
begin
  if actor_user_id is null or not exists(select 1 from auth.users u where u.id = actor_user_id) then
    raise exception 'Player required' using errcode = '42501', hint = 'player_required';
  end if;
  acquired := private.allocation_acquire(target_court_id,'rental',starts,ends,hold_until,actor_user_id,request);
  snapshot := private.rental_snapshot_create((acquired->'allocation'->>'id')::uuid);
  return acquired || jsonb_build_object('snapshot',snapshot);
end;
$$;

revoke all on function private.rental_snapshot_immutable(), private.validate_rental_window(timestamptz,timestamptz,timestamptz),
  private.rental_price(timestamptz,timestamptz,jsonb), private.rental_snapshot_create(uuid),
  private.rental_acquire(uuid,uuid,timestamptz,timestamptz,timestamptz,uuid) from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
