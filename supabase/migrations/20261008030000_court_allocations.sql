-- T21: authoritative shared court inventory. Generic allocations only: booking
-- and session records, the owner calendar, checkout and scheduled cleanup are
-- later tasks. PostgreSQL alone holds inventory; Redis never locks or caches it.
create extension if not exists btree_gist with schema extensions;

-- Half-open [starts_at, ends_at) UTC intervals. expires_at null is firm; otherwise
-- the row is a hold that stops consuming inventory at expires_at, whether or not
-- any write has marked it expired yet. Rows are never deleted by commands.
create table private.court_allocations (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  kind text not null check (kind in ('block','rental','session')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  expires_at timestamptz,
  state text not null default 'active' check (state in ('active','released','expired')),
  ended_at timestamptz,
  -- Retry key. No FK on the requester, like the audit tables (T47 retention).
  requested_by uuid not null,
  request_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (requested_by, request_id),
  check (starts_at >= timestamptz '2000-01-01 00:00+08' and ends_at <= timestamptz '2100-01-01 00:00+08'),
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  check (mod(extract(epoch from starts_at), 1800) = 0 and mod(extract(epoch from ends_at), 1800) = 0),
  check (expires_at is null or expires_at <= starts_at),
  check ((state = 'active') = (ended_at is null)),
  -- Backstop for the court lock below: active rows on one court never overlap.
  constraint court_allocations_no_overlap exclude using gist
    (court_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (state = 'active')
);
create index court_allocations_venue_active on private.court_allocations (venue_id, starts_at) where state = 'active';
alter table private.court_allocations enable row level security;
revoke all on private.court_allocations from public, anon, authenticated, service_role;

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
  'directory.create','directory.update','directory.publish','directory.unpublish','directory.suspend','directory.import',
  'owner.update','owner.photo_add','owner.photo_remove','schedule.update','policy.update',
  'allocation.block','allocation.release'));

-- The one definition of "consumes inventory at at_time".
create function private.allocation_live(allocation_state text, hold_expires_at timestamptz, at_time timestamptz) returns boolean
language sql immutable set search_path = '' as $$
  select allocation_state = 'active' and (hold_expires_at is null or hold_expires_at > at_time);
$$;

create function private.allocation_json(a private.court_allocations, at_time timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', a.id, 'venue_id', a.venue_id, 'court_id', a.court_id, 'kind', a.kind,
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'expires_at', a.expires_at,
    -- An elapsed hold reads as expired before any write marks it.
    'state', case when a.state = 'active' and a.expires_at <= at_time then 'expired' else a.state end,
    'ended_at', case when a.state = 'active' and a.expires_at <= at_time then a.expires_at else a.ended_at end);
$$;

-- The interval must lie inside contiguous resolved T19 opening hours. Hours are a
-- prerequisite, never availability: allocations are checked separately.
create function private.allocation_within_hours(target_venue_id uuid, starts timestamptz, ends timestamptz) returns boolean
language plpgsql stable set search_path = '' as $$
declare first_date date := (starts at time zone 'Asia/Manila')::date;
  last_date date := ((ends - interval '1 microsecond') at time zone 'Asia/Manila')::date;
  covered timestamptz := starts; band record;
begin
  for band in select (i ->> 'starts_at')::timestamptz as opens, (i ->> 'ends_at')::timestamptz as closes
    from jsonb_array_elements(private.resolve_venue_schedule(target_venue_id, first_date, last_date - first_date + 1)) i
    order by 1 loop
    exit when band.opens > covered;
    covered := greatest(covered, band.closes);
    if covered >= ends then return true; end if;
  end loop;
  return false;
end;
$$;

-- Server-only primitive for later command wrappers, which authorize first.
-- Lock order: venue (share, or the caller's stronger editor lock), then court, then
-- allocation rows. Venue-first editors (T11/T18/T19, later T22 guards) therefore
-- cannot interleave a court deactivation or schedule save with an acquisition, and
-- acquisitions on one court serialize. The clock is read once, after the locks.
create function private.allocation_acquire(target_court_id uuid, allocation_kind text, starts timestamptz,
  ends timestamptz, hold_until timestamptz, requester uuid, request uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare court public.courts; listing_status public.venue_publication_status;
  existing private.court_allocations; saved private.court_allocations; at_time timestamptz;
begin
  if target_court_id is null or requester is null or request is null or starts is null or ends is null
    or allocation_kind is null or allocation_kind not in ('block','rental','session') then
    raise exception 'Invalid allocation' using errcode = '22023', hint = 'invalid_input';
  end if;
  select c.* into court from public.courts c where c.id = target_court_id;
  if not found then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  select v.publication_status into listing_status from public.venues v where v.id = court.venue_id for share;
  select c.* into court from public.courts c where c.id = target_court_id for no key update;
  if not found then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  at_time := clock_timestamp();
  -- A retry returns the original row as it stands now; it never revives inventory.
  select a.* into existing from private.court_allocations a where a.requested_by = requester and a.request_id = request;
  if found then
    if existing.court_id <> target_court_id or existing.kind <> allocation_kind
      or existing.starts_at <> starts or existing.ends_at <> ends then
      raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
    end if;
    return jsonb_build_object('outcome', 'existing', 'allocation', private.allocation_json(existing, at_time));
  end if;
  if listing_status is null or listing_status = 'suspended' then
    raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  if court.status <> 'active' then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  if ends <= starts or ends - starts > interval '24 hours' or ends <= at_time
    or mod(extract(epoch from starts), 1800) <> 0 or mod(extract(epoch from ends), 1800) <> 0
    or starts < timestamptz '2000-01-01 00:00+08' or ends > timestamptz '2100-01-01 00:00+08'
    -- Locked hold rules: at most 2 hours, capped at the start time.
    or (hold_until is not null and (hold_until <= at_time or hold_until > starts or hold_until > at_time + interval '2 hours')) then
    raise exception 'Invalid allocation' using errcode = '22023', hint = 'invalid_input';
  end if;
  if not private.allocation_within_hours(court.venue_id, starts, ends) then
    raise exception 'Outside opening hours' using errcode = '23514', hint = 'outside_hours';
  end if;
  -- Elapsed holds on this court stop consuming inventory now, with or without a cleanup job.
  update private.court_allocations a set state = 'expired', ended_at = a.expires_at
    where a.court_id = target_court_id and a.state = 'active' and a.expires_at <= at_time;
  if exists (select 1 from private.court_allocations a where a.court_id = target_court_id and a.state = 'active'
    and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(starts, ends, '[)')) then
    raise exception 'Court already allocated' using errcode = '23P01', hint = 'allocation_conflict';
  end if;
  begin
    insert into private.court_allocations (venue_id, court_id, kind, starts_at, ends_at, expires_at, requested_by, request_id)
      values (court.venue_id, target_court_id, allocation_kind, starts, ends, hold_until, requester, request)
      returning * into saved;
  exception
    when exclusion_violation then
      raise exception 'Court already allocated' using errcode = '23P01', hint = 'allocation_conflict';
    when unique_violation then
      raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end;
  return jsonb_build_object('outcome', 'created', 'allocation', private.allocation_json(saved, at_time));
end;
$$;

-- Idempotent. Releasing frees inventory, so only the allocation row is locked.
create function private.allocation_release(target_allocation_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare a private.court_allocations; at_time timestamptz;
begin
  select x.* into a from private.court_allocations x where x.id = target_allocation_id for update;
  if not found then
    raise exception 'Allocation not found' using errcode = 'P0002', hint = 'allocation_not_found';
  end if;
  at_time := clock_timestamp();
  if a.state <> 'active' then
    return jsonb_build_object('outcome', 'existing', 'allocation', private.allocation_json(a, at_time));
  end if;
  if a.expires_at <= at_time then
    update private.court_allocations x set state = 'expired', ended_at = x.expires_at where x.id = a.id returning * into a;
    return jsonb_build_object('outcome', 'existing', 'allocation', private.allocation_json(a, at_time));
  end if;
  update private.court_allocations x set state = 'released', ended_at = at_time where x.id = a.id returning * into a;
  return jsonb_build_object('outcome', 'released', 'allocation', private.allocation_json(a, at_time));
end;
$$;

-- Moves a live hold to a new expiry (e.g. approval hold to payment hold) or, with
-- null, makes it firm. A live row already excludes overlaps, so no court lock is
-- needed; an acquisition that marked it expired first wins and this fails.
create function private.allocation_renew(target_allocation_id uuid, hold_until timestamptz) returns jsonb
language plpgsql set search_path = '' as $$
declare a private.court_allocations; at_time timestamptz;
begin
  select x.* into a from private.court_allocations x where x.id = target_allocation_id for update;
  if not found then
    raise exception 'Allocation not found' using errcode = 'P0002', hint = 'allocation_not_found';
  end if;
  at_time := clock_timestamp();
  if not private.allocation_live(a.state, a.expires_at, at_time) then
    raise exception 'Allocation ended' using errcode = '55000', hint = 'allocation_ended';
  end if;
  if a.expires_at is null then
    if hold_until is null then
      return jsonb_build_object('outcome', 'existing', 'allocation', private.allocation_json(a, at_time));
    end if;
    raise exception 'Firm allocations cannot become holds' using errcode = '22023', hint = 'invalid_input';
  end if;
  if hold_until is not null and (hold_until <= at_time or hold_until > a.starts_at or hold_until > at_time + interval '2 hours') then
    raise exception 'Invalid hold' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.court_allocations x set expires_at = hold_until where x.id = a.id returning * into a;
  return jsonb_build_object('outcome', 'renewed', 'allocation', private.allocation_json(a, at_time));
end;
$$;

create function private.allocation_list(target_venue_id uuid, range_start timestamptz, range_end timestamptz, at_time timestamptz) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(private.allocation_json(a, at_time) order by a.starts_at, a.court_id, a.id), '[]'::jsonb)
  from private.court_allocations a
  where a.venue_id = target_venue_id and private.allocation_live(a.state, a.expires_at, at_time)
    and a.starts_at < range_end and a.ends_at > range_start;
$$;

-- Owner/admin blocks: outside bookings, maintenance and walk-ins (T22 adds the UI).
-- Same editors and locks as T19 schedule saves; each creation/release is audited
-- atomically, retries are not.
create function public.court_allocation_block(actor_user_id uuid, target_court_id uuid, block_request_id uuid,
  block_starts_at timestamptz, block_ends_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target_venue_id uuid; result jsonb;
begin
  select c.venue_id into target_venue_id from public.courts c where c.id = target_court_id;
  if not found then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  perform private.require_schedule_editor(actor_user_id, target_venue_id);
  result := private.allocation_acquire(target_court_id, 'block', block_starts_at, block_ends_at, null, actor_user_id, block_request_id);
  if result ->> 'outcome' = 'created' then
    insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
      values (actor_user_id, target_venue_id, 'allocation.block');
  end if;
  return result;
end;
$$;

create function public.court_allocation_release(actor_user_id uuid, target_allocation_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target_venue_id uuid; allocation_kind text; result jsonb;
begin
  select a.venue_id, a.kind into target_venue_id, allocation_kind from private.court_allocations a where a.id = target_allocation_id;
  if not found then
    raise exception 'Allocation not found' using errcode = 'P0002', hint = 'allocation_not_found';
  end if;
  perform private.require_schedule_editor(actor_user_id, target_venue_id);
  -- Rentals and sessions change only through their booking commands (T24+).
  if allocation_kind <> 'block' then
    raise exception 'Managed by booking commands' using errcode = '42501', hint = 'managed_allocation';
  end if;
  result := private.allocation_release(target_allocation_id);
  if result ->> 'outcome' = 'released' then
    insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
      values (actor_user_id, target_venue_id, 'allocation.release');
  end if;
  return result;
end;
$$;

-- Live inventory only (elapsed holds excluded at read time). No locks: one snapshot.
create function public.court_allocation_read(actor_user_id uuid, target_venue_id uuid,
  range_start timestamptz, range_end timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if private.has_account_role(actor_user_id, 'admin') then
    if not exists (select 1 from public.venues v where v.id = target_venue_id and v.publication_status <> 'suspended') then
      raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
    end if;
  elsif not exists (select 1 from private.venue_owners o where o.user_id = actor_user_id and o.venue_id = target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  elsif not private.is_verified_venue_owner(actor_user_id, target_venue_id) then
    raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  if range_start is null or range_end is null or range_end <= range_start or range_end - range_start > interval '31 days'
    or range_start < timestamptz '2000-01-01 00:00+08' or range_end > timestamptz '2100-01-01 00:00+08' then
    raise exception 'Invalid range' using errcode = '22023', hint = 'invalid_input';
  end if;
  return jsonb_build_object('venue_id', target_venue_id,
    'allocations', private.allocation_list(target_venue_id, range_start, range_end, clock_timestamp()));
end;
$$;

revoke all on function private.allocation_live(text,timestamptz,timestamptz), private.allocation_json(private.court_allocations,timestamptz),
  private.allocation_within_hours(uuid,timestamptz,timestamptz),
  private.allocation_acquire(uuid,text,timestamptz,timestamptz,timestamptz,uuid,uuid),
  private.allocation_release(uuid), private.allocation_renew(uuid,timestamptz),
  private.allocation_list(uuid,timestamptz,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.court_allocation_block(uuid,uuid,uuid,timestamptz,timestamptz),
  public.court_allocation_release(uuid,uuid), public.court_allocation_read(uuid,uuid,timestamptz,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.court_allocation_block(uuid,uuid,uuid,timestamptz,timestamptz),
  public.court_allocation_release(uuid,uuid), public.court_allocation_read(uuid,uuid,timestamptz,timestamptz) to service_role;
notify pgrst, 'reload schema';
