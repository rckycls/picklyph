-- T22: court-specific hours and closures, the owner calendar read, and guards that
-- stop schedule edits and court deactivation from displacing live allocations.
-- Court rules only narrow T19 venue hours, so venue rates still price every open
-- minute. Bookings, approvals and check-in are later tasks.

-- One optional rule set per court. custom_weekly false: the court follows venue
-- weekly hours; its dated closures still apply.
create table private.court_schedules (
  court_id uuid primary key references public.courts(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9999999999999999),
  custom_weekly boolean not null
);
-- Same-day windows (no overnight spill): a court open across midnight lists the
-- late window on one day and the early window on the next.
create table private.court_hours (
  court_id uuid not null references private.court_schedules(court_id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_minute integer not null check (start_minute between 0 and 1410 and start_minute % 30 = 0),
  end_minute integer not null check (end_minute between 30 and 1440 and end_minute % 30 = 0 and end_minute > start_minute),
  primary key (court_id, weekday, start_minute)
);
-- A closure closes the court for the entire Manila civil date.
create table private.court_closures (
  court_id uuid not null references private.court_schedules(court_id) on delete cascade,
  local_date date not null check (local_date between date '2000-01-01' and date '2099-12-31'),
  primary key (court_id, local_date)
);
alter table private.court_schedules enable row level security;
alter table private.court_hours enable row level security;
alter table private.court_closures enable row level security;
revoke all on private.court_schedules, private.court_hours, private.court_closures from public, anon, authenticated, service_role;

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
  'directory.create','directory.update','directory.publish','directory.unpublish','directory.suspend','directory.import',
  'owner.update','owner.photo_add','owner.photo_remove','schedule.update','policy.update',
  'allocation.block','allocation.release','schedule.court_update'));

-- Court-local open minutes of one civil date: a closure closes it, custom weekly
-- hours replace the whole day, otherwise the whole day is open (venue hours still apply).
create function private.court_day_ranges(target_court_id uuid, civil_date date)
returns table(start_minute integer, end_minute integer)
language sql stable set search_path = '' as $$
  select h.start_minute, h.end_minute from private.court_schedules s
    join private.court_hours h on h.court_id = s.court_id and h.weekday = extract(dow from civil_date)::integer
    where s.court_id = target_court_id and s.custom_weekly
      and not exists (select 1 from private.court_closures c where c.court_id = target_court_id and c.local_date = civil_date)
  union all
  select 0, 1440 where not exists (select 1 from private.court_schedules s where s.court_id = target_court_id and s.custom_weekly)
    and not exists (select 1 from private.court_closures c where c.court_id = target_court_id and c.local_date = civil_date);
$$;

-- Venue intervals (already split at Manila midnight and rate changes) intersected
-- with the court's ranges for the same civil date. Same shape as resolve_venue_schedule.
create function private.resolve_court_hours(target_court_id uuid, first_date date, day_count integer) returns jsonb
language plpgsql stable set search_path = '' as $$
declare target_venue_id uuid;
begin
  select c.venue_id into target_venue_id from public.courts c where c.id = target_court_id;
  if not found then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('starts_at', greatest(v.opens, r.opens), 'ends_at', least(v.closes, r.closes),
      'hourly_centavos', v.cents) order by greatest(v.opens, r.opens))
    from (select (i ->> 'starts_at')::timestamptz as opens, (i ->> 'ends_at')::timestamptz as closes, (i ->> 'hourly_centavos')::bigint as cents
      from jsonb_array_elements(private.resolve_venue_schedule(target_venue_id, first_date, day_count)) i) v
    cross join lateral (select (d.civil_date::timestamp + x.start_minute * interval '1 minute') at time zone 'Asia/Manila' as opens,
        (d.civil_date::timestamp + x.end_minute * interval '1 minute') at time zone 'Asia/Manila' as closes
      from (select (v.opens at time zone 'Asia/Manila')::date as civil_date) d
      cross join private.court_day_ranges(target_court_id, d.civil_date) x) r
    where r.opens < v.closes and v.opens < r.closes), '[]'::jsonb);
end;
$$;

-- Replaces T21's venue-wide check: the interval must lie inside contiguous resolved
-- court hours. Hours are a prerequisite, never availability.
create function private.court_within_hours(target_court_id uuid, starts timestamptz, ends timestamptz) returns boolean
language plpgsql stable set search_path = '' as $$
declare first_date date := (starts at time zone 'Asia/Manila')::date;
  last_date date := ((ends - interval '1 microsecond') at time zone 'Asia/Manila')::date;
  covered timestamptz := starts; band record;
begin
  for band in select (i ->> 'starts_at')::timestamptz as opens, (i ->> 'ends_at')::timestamptz as closes
    from jsonb_array_elements(private.resolve_court_hours(target_court_id, first_date, last_date - first_date + 1)) i
    order by 1 loop
    exit when band.opens > covered;
    covered := greatest(covered, band.closes);
    if covered >= ends then return true; end if;
  end loop;
  return false;
end;
$$;

-- T21 body with one change: court hours instead of venue-wide hours.
create or replace function private.allocation_acquire(target_court_id uuid, allocation_kind text, starts timestamptz,
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
  if not private.court_within_hours(target_court_id, starts, ends) then
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
drop function private.allocation_within_hours(uuid, timestamptz, timestamptz);

-- Every live allocation (holds until expiry) that has not ended must still fit its
-- court's hours after a rules change. Callers hold the venue editor lock, which
-- every acquisition must share first, so none can slip in before commit.
create function private.require_hours_cover_allocations(target_venue_id uuid, target_court_id uuid) returns void
language plpgsql set search_path = '' as $$
declare at_time timestamptz := clock_timestamp(); a record;
begin
  for a in select x.court_id, x.starts_at, x.ends_at from private.court_allocations x
    where x.venue_id = target_venue_id and (target_court_id is null or x.court_id = target_court_id)
      and private.allocation_live(x.state, x.expires_at, at_time) and x.ends_at > at_time
    order by x.starts_at loop
    if not private.court_within_hours(a.court_id, a.starts_at, a.ends_at) then
      raise exception 'These hours would displace a block or booking' using errcode = '55006', hint = 'hours_conflict';
    end if;
  end loop;
end;
$$;

-- T19 body with one addition: the displacement guard before the audit row.
create or replace function public.venue_schedule_save(actor_user_id uuid, target_venue_id uuid, expected_revision text, schedule_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare version bigint; e jsonb; dated date; check_date date; end_minute integer; band record; d integer;
begin
  perform private.require_schedule_editor(actor_user_id,target_venue_id);
  if expected_revision is not null and expected_revision !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'Invalid revision' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.revision into version from private.venue_schedules s where s.venue_id = target_venue_id;
  if version::text is distinct from expected_revision then
    raise exception 'Schedule changed; reload' using errcode = '40001', hint = 'version_conflict';
  end if;
  if jsonb_typeof(schedule_input) is distinct from 'object' then
    raise exception 'Invalid schedule' using errcode = '22023', hint = 'invalid_input';
  end if;
  if not schedule_input ?& array['weekly','exceptions'] or (select count(*) from jsonb_object_keys(schedule_input)) <> 2
    or jsonb_typeof(schedule_input -> 'weekly') is distinct from 'array' or jsonb_typeof(schedule_input -> 'exceptions') is distinct from 'array' then
    raise exception 'Invalid schedule' using errcode = '22023', hint = 'invalid_input';
  end if;
  if jsonb_array_length(schedule_input -> 'weekly') <> 7 or jsonb_array_length(schedule_input -> 'exceptions') > 120 then
    raise exception 'Invalid schedule' using errcode = '22023', hint = 'invalid_input';
  end if;
  insert into private.venue_schedules values(target_venue_id,1)
    on conflict (venue_id) do update set revision = private.venue_schedules.revision + 1 returning revision into version;
  delete from private.schedule_windows w where w.venue_id = target_venue_id;
  delete from private.schedule_exceptions x where x.venue_id = target_venue_id;
  for d in 0..6 loop
    perform private.schedule_insert_windows(target_venue_id,d,null,schedule_input -> 'weekly' -> d);
  end loop;
  for e in select value from jsonb_array_elements(schedule_input -> 'exceptions') loop
    if jsonb_typeof(e) is distinct from 'object' then
      raise exception 'Invalid exception' using errcode = '22023', hint = 'invalid_input';
    end if;
    if not e ?& array['date','windows'] or (select count(*) from jsonb_object_keys(e)) <> 2
      or jsonb_typeof(e -> 'date') is distinct from 'string' or e ->> 'date' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid exception' using errcode = '22023', hint = 'invalid_input';
    end if;
    begin dated := (e ->> 'date')::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'Invalid exception date' using errcode = '22023', hint = 'invalid_input';
    end;
    if exists (select 1 from private.schedule_exceptions x where x.venue_id = target_venue_id and x.local_date = dated) then
      raise exception 'Duplicate exception date' using errcode = '22023', hint = 'invalid_input';
    end if;
    insert into private.schedule_exceptions values(target_venue_id,dated);
    perform private.schedule_insert_windows(target_venue_id,null,dated,e -> 'windows');
  end loop;
  -- Cyclic week includes Saturday/Sunday; exceptions and the next date include spill-out.
  for d in 0..6 loop
    end_minute := -1;
    for band in select * from private.schedule_bands(target_venue_id,date '2026-01-04' + d,true) loop
      if band.start_minute < end_minute then
        raise exception 'Overnight hours overlap the next day' using errcode = '22023', hint = 'invalid_input';
      end if;
      end_minute := band.end_minute;
    end loop;
  end loop;
  for check_date in select local_date from private.schedule_exceptions where venue_id = target_venue_id
    union select local_date + 1 from private.schedule_exceptions where venue_id = target_venue_id loop
    end_minute := -1;
    for band in select * from private.schedule_bands(target_venue_id,check_date) loop
      if band.start_minute < end_minute then
        raise exception 'Exception hours overlap the next day' using errcode = '22023', hint = 'invalid_input';
      end if;
      end_minute := band.end_minute;
    end loop;
  end loop;
  perform private.require_hours_cover_allocations(target_venue_id, null);
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
    values(actor_user_id,target_venue_id,'schedule.update');
  return jsonb_build_object('venue_id',target_venue_id,'revision',version::text,'schedule',private.schedule_json(target_venue_id),'intervals','[]'::jsonb);
end;
$$;

-- Backstop for every path (T18 owner saves, T11 curation, trusted SQL): a court with
-- a live allocation that has not ended stays active. The UPDATE holds the court row
-- lock that acquisitions also take, and the venue-first editors hold the venue too.
create function private.guard_court_deactivation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz := clock_timestamp();
begin
  if exists (select 1 from private.court_allocations a where a.court_id = new.id
    and private.allocation_live(a.state, a.expires_at, at_time) and a.ends_at > at_time) then
    raise exception 'Court has upcoming blocks or bookings' using errcode = '55006', hint = 'court_allocated';
  end if;
  return new;
end;
$$;
create trigger courts_guard_deactivation before update of status on public.courts for each row
  when (old.status = 'active' and new.status is distinct from 'active') execute function private.guard_court_deactivation();

create function private.court_hours_json(target_court_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('court_id', target_court_id, 'revision', s.revision::text, 'hours', jsonb_build_object(
    'weekly', case when s.custom_weekly then (select jsonb_agg(coalesce((select jsonb_agg(jsonb_build_object(
        'start_minute', h.start_minute, 'end_minute', h.end_minute) order by h.start_minute)
      from private.court_hours h where h.court_id = target_court_id and h.weekday = d), '[]'::jsonb) order by d)
      from generate_series(0,6) d) end,
    'closures', coalesce((select jsonb_agg(to_char(c.local_date, 'YYYY-MM-DD') order by c.local_date)
      from private.court_closures c where c.court_id = target_court_id), '[]'::jsonb)))
  from (select 1) one left join private.court_schedules s on s.court_id = target_court_id;
$$;

-- actor_user_id MUST come from a server-verified token. Same editors and locks as
-- T19 schedule saves. hours_input is exactly {weekly, closures}; weekly null follows
-- the venue's weekly hours. Saves replace the court's rules and bump its revision.
create function public.court_hours_save(actor_user_id uuid, target_court_id uuid, expected_revision text, hours_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target_venue_id uuid; version bigint; custom boolean; d integer; w jsonb; a integer; b integer;
  previous_end integer; closure jsonb; dated date;
begin
  select c.venue_id into target_venue_id from public.courts c where c.id = target_court_id;
  if not found then
    raise exception 'Court unavailable' using errcode = 'P0002', hint = 'court_unavailable';
  end if;
  perform private.require_schedule_editor(actor_user_id, target_venue_id);
  if expected_revision is not null and expected_revision !~ '^[1-9][0-9]{0,15}$' then
    raise exception 'Invalid revision' using errcode = '22023', hint = 'invalid_input';
  end if;
  select s.revision into version from private.court_schedules s where s.court_id = target_court_id;
  if version::text is distinct from expected_revision then
    raise exception 'Court hours changed; reload' using errcode = '40001', hint = 'version_conflict';
  end if;
  if jsonb_typeof(hours_input) is distinct from 'object' or not hours_input ?& array['weekly','closures']
    or (select count(*) from jsonb_object_keys(hours_input)) <> 2
    or jsonb_typeof(hours_input -> 'weekly') not in ('null','array') or jsonb_typeof(hours_input -> 'closures') is distinct from 'array'
    or jsonb_array_length(hours_input -> 'closures') > 120 then
    raise exception 'Invalid court hours' using errcode = '22023', hint = 'invalid_input';
  end if;
  custom := jsonb_typeof(hours_input -> 'weekly') = 'array';
  if custom and jsonb_array_length(hours_input -> 'weekly') <> 7 then
    raise exception 'Invalid court hours' using errcode = '22023', hint = 'invalid_input';
  end if;
  insert into private.court_schedules values (target_court_id, 1, custom)
    on conflict (court_id) do update set revision = private.court_schedules.revision + 1, custom_weekly = excluded.custom_weekly
    returning revision into version;
  delete from private.court_hours h where h.court_id = target_court_id;
  delete from private.court_closures c where c.court_id = target_court_id;
  if custom then
    for d in 0..6 loop
      if jsonb_typeof(hours_input -> 'weekly' -> d) is distinct from 'array' or jsonb_array_length(hours_input -> 'weekly' -> d) > 4 then
        raise exception 'Invalid court hours' using errcode = '22023', hint = 'invalid_input';
      end if;
      previous_end := -1;
      for w in select value from jsonb_array_elements(hours_input -> 'weekly' -> d) loop
        if jsonb_typeof(w) is distinct from 'object' or not w ?& array['start_minute','end_minute']
          or (select count(*) from jsonb_object_keys(w)) <> 2 then
          raise exception 'Invalid court hours' using errcode = '22023', hint = 'invalid_input';
        end if;
        a := private.schedule_minute(w -> 'start_minute'); b := private.schedule_minute(w -> 'end_minute');
        if a >= 1440 or b <= a or b > 1440 or a < previous_end then
          raise exception 'Overlapping court hours' using errcode = '22023', hint = 'invalid_input';
        end if;
        previous_end := b;
        insert into private.court_hours values (target_court_id, d, a, b);
      end loop;
    end loop;
  end if;
  for closure in select value from jsonb_array_elements(hours_input -> 'closures') loop
    if jsonb_typeof(closure) is distinct from 'string' or closure #>> '{}' !~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid closure' using errcode = '22023', hint = 'invalid_input';
    end if;
    begin dated := (closure #>> '{}')::date;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'Invalid closure date' using errcode = '22023', hint = 'invalid_input';
    end;
    if exists (select 1 from private.court_closures c where c.court_id = target_court_id and c.local_date = dated) then
      raise exception 'Duplicate closure date' using errcode = '22023', hint = 'invalid_input';
    end if;
    insert into private.court_closures values (target_court_id, dated);
  end loop;
  perform private.require_hours_cover_allocations(target_venue_id, target_court_id);
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
    values (actor_user_id, target_venue_id, 'schedule.court_update');
  return private.court_hours_json(target_court_id);
end;
$$;

-- Owner calendar: courts, their resolved hours and live inventory for 1–7 Manila
-- days. T21 read authorization; no editor lock. The whole reply is one statement,
-- so hours, courts and allocations come from one snapshot at one server clock.
create function public.owner_calendar_read(actor_user_id uuid, target_venue_id uuid, start_date date, days integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz; range_start timestamptz; range_end timestamptz;
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
  if start_date is null or days is null or days not between 1 and 7
    or start_date < date '2000-01-01' or start_date + (days - 1) > date '2099-12-31' then
    raise exception 'Invalid range' using errcode = '22023', hint = 'invalid_input';
  end if;
  range_start := start_date::timestamp at time zone 'Asia/Manila';
  range_end := (start_date + days)::timestamp at time zone 'Asia/Manila';
  at_time := clock_timestamp();
  return (select jsonb_build_object('venue_id', v.id, 'name', v.name, 'start_date', to_char(start_date, 'YYYY-MM-DD'), 'days', days,
    'at', at_time, 'schedule_revision', (select s.revision::text from private.venue_schedules s where s.venue_id = v.id),
    'courts', coalesce((select jsonb_agg(private.court_hours_json(c.id) || jsonb_build_object('name', c.name, 'status', c.status,
        'intervals', private.resolve_court_hours(c.id, start_date, days)) order by c.name, c.id)
      from public.courts c where c.venue_id = v.id), '[]'::jsonb),
    'allocations', private.allocation_list(v.id, range_start, range_end, at_time))
    from public.venues v where v.id = target_venue_id);
end;
$$;

revoke all on function private.court_day_ranges(uuid,date), private.resolve_court_hours(uuid,date,integer),
  private.court_within_hours(uuid,timestamptz,timestamptz), private.require_hours_cover_allocations(uuid,uuid),
  private.guard_court_deactivation(), private.court_hours_json(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.court_hours_save(uuid,uuid,text,jsonb), public.owner_calendar_read(uuid,uuid,date,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.court_hours_save(uuid,uuid,text,jsonb), public.owner_calendar_read(uuid,uuid,date,integer) to service_role;
notify pgrst, 'reload schema';
