-- T19: venue-wide hours and rates only. No allocations, availability or price snapshots.
create table private.venue_schedules (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  revision bigint not null check (revision between 1 and 9999999999999999)
);
create table private.schedule_exceptions (
  venue_id uuid not null references private.venue_schedules(venue_id) on delete cascade,
  local_date date not null check (local_date between date '2000-01-01' and date '2099-12-31'),
  primary key (venue_id, local_date)
);
create table private.schedule_windows (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references private.venue_schedules(venue_id) on delete cascade,
  weekday smallint check (weekday between 0 and 6),
  exception_date date,
  start_minute integer not null check (start_minute between 0 and 1410 and start_minute % 30 = 0),
  end_minute integer not null check (end_minute % 30 = 0 and end_minute > start_minute and end_minute <= start_minute + 1440),
  check ((weekday is null) <> (exception_date is null)),
  foreign key (venue_id, exception_date) references private.schedule_exceptions(venue_id, local_date) on delete cascade
);
create index schedule_windows_venue on private.schedule_windows(venue_id);
create table private.schedule_rates (
  window_id uuid not null references private.schedule_windows(id) on delete cascade,
  start_minute integer not null check (start_minute between 0 and 2850 and start_minute % 30 = 0),
  end_minute integer not null check (end_minute between 30 and 2880 and end_minute % 30 = 0 and end_minute > start_minute),
  hourly_centavos bigint not null check (hourly_centavos between 0 and 9007199254740991),
  primary key (window_id, start_minute)
);
alter table private.venue_schedules enable row level security;
alter table private.schedule_exceptions enable row level security;
alter table private.schedule_windows enable row level security;
alter table private.schedule_rates enable row level security;
revoke all on private.venue_schedules, private.schedule_exceptions, private.schedule_windows, private.schedule_rates
  from public, anon, authenticated, service_role;

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
    'directory.create', 'directory.update', 'directory.publish', 'directory.unpublish', 'directory.suspend', 'directory.import',
    'owner.update', 'owner.photo_add', 'owner.photo_remove', 'schedule.update'));

-- Admin locking follows T11 (role, then venue); owner locking follows T18
-- (venue, then owner link). Both retain their current authorization through commit.
create function private.require_schedule_editor(actor_id uuid, target_venue_id uuid) returns void
language plpgsql set search_path = '' as $$
declare listing public.venues;
begin
  if exists (select 1 from private.account_roles r where r.user_id = actor_id and r.role = 'admin') then
    perform private.require_directory_admin(actor_id);
    select v.* into listing from public.venues v where v.id = target_venue_id for update;
    if not found or listing.publication_status = 'suspended' then
      raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
    end if;
  else
    perform private.require_venue_owner(actor_id, target_venue_id);
  end if;
end;
$$;

create function private.schedule_minute(value jsonb) returns integer
language plpgsql immutable set search_path = '' as $$
declare n numeric;
begin
  if jsonb_typeof(value) is distinct from 'number' then
    raise exception 'Invalid minute' using errcode = '22023', hint = 'invalid_input';
  end if;
  n := (value #>> '{}')::numeric;
  if n < 0 or n > 2880 or mod(n,30) <> 0 then
    raise exception 'Invalid minute' using errcode = '22023', hint = 'invalid_input';
  end if;
  return n::integer;
end;
$$;

create function private.schedule_insert_windows(target uuid, day_number integer, dated date, windows jsonb) returns void
language plpgsql set search_path = '' as $$
declare w jsonb; r jsonb; a integer; b integer; x integer; y integer; cursor_minute integer;
  previous_end integer := -1; window_id uuid; cents numeric;
begin
  if jsonb_typeof(windows) is distinct from 'array' then
    raise exception 'Invalid hours' using errcode = '22023', hint = 'invalid_input';
  end if;
  if jsonb_array_length(windows) > 4 then
    raise exception 'Too many hours' using errcode = '22023', hint = 'invalid_input';
  end if;
  for w in select value from jsonb_array_elements(windows) loop
    if jsonb_typeof(w) is distinct from 'object' then
      raise exception 'Invalid hours' using errcode = '22023', hint = 'invalid_input';
    end if;
    if not w ?& array['start_minute','end_minute','rates'] or (select count(*) from jsonb_object_keys(w)) <> 3 then
      raise exception 'Invalid hours' using errcode = '22023', hint = 'invalid_input';
    end if;
    a := private.schedule_minute(w -> 'start_minute'); b := private.schedule_minute(w -> 'end_minute');
    if a >= 1440 or b <= a or b - a > 1440 or a < previous_end or jsonb_typeof(w -> 'rates') is distinct from 'array' then
      raise exception 'Overlapping hours' using errcode = '22023', hint = 'invalid_input';
    end if;
    if jsonb_array_length(w -> 'rates') not between 1 and 16 then
      raise exception 'Invalid rates' using errcode = '22023', hint = 'invalid_input';
    end if;
    previous_end := b; cursor_minute := a;
    insert into private.schedule_windows(venue_id,weekday,exception_date,start_minute,end_minute)
      values(target,day_number,dated,a,b) returning id into window_id;
    for r in select value from jsonb_array_elements(w -> 'rates') loop
      if jsonb_typeof(r) is distinct from 'object' then
        raise exception 'Invalid rate' using errcode = '22023', hint = 'invalid_input';
      end if;
      if not r ?& array['start_minute','end_minute','hourly_centavos'] or (select count(*) from jsonb_object_keys(r)) <> 3
        or jsonb_typeof(r -> 'hourly_centavos') is distinct from 'number' then
        raise exception 'Invalid rate' using errcode = '22023', hint = 'invalid_input';
      end if;
      x := private.schedule_minute(r -> 'start_minute'); y := private.schedule_minute(r -> 'end_minute');
      cents := (r ->> 'hourly_centavos')::numeric;
      if x <> cursor_minute or y <= x or y > b or cents < 0 or cents > 9007199254740991 or cents <> trunc(cents) then
        raise exception 'Rates must exactly cover opening hours' using errcode = '22023', hint = 'invalid_input';
      end if;
      cursor_minute := y;
      insert into private.schedule_rates values(window_id,x,y,cents::bigint);
    end loop;
    if cursor_minute <> b then
      raise exception 'Rate gap' using errcode = '22023', hint = 'invalid_input';
    end if;
  end loop;
end;
$$;

-- Resolve one civil date. Exceptions suppress yesterday's spill into that date.
-- ignore_exceptions checks the underlying cyclic week independently of overrides.
create function private.schedule_bands(target uuid, civil_date date, ignore_exceptions boolean default false)
returns table(start_minute integer, end_minute integer, hourly_centavos bigint)
language sql stable set search_path = '' as $$
  select greatest(r.start_minute - anchor.offset_minutes,0), least(r.end_minute - anchor.offset_minutes,1440), r.hourly_centavos
  from (values (civil_date,0), (civil_date - 1,1440)) anchor(local_date,offset_minutes)
  join private.schedule_windows w on w.venue_id = target and
    (case when not ignore_exceptions and exists (select 1 from private.schedule_exceptions e
      where e.venue_id = target and e.local_date = anchor.local_date)
    then w.exception_date = anchor.local_date else w.weekday = extract(dow from anchor.local_date)::integer end)
  join private.schedule_rates r on r.window_id = w.id
  where r.end_minute > anchor.offset_minutes and r.start_minute < anchor.offset_minutes + 1440
    and (anchor.offset_minutes = 0 or ignore_exceptions or not exists
      (select 1 from private.schedule_exceptions e where e.venue_id = target and e.local_date = civil_date))
  order by 1,2;
$$;

create function private.schedule_window_json(target uuid, day_number integer, dated date) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('start_minute',w.start_minute,'end_minute',w.end_minute,
    'rates',(select jsonb_agg(jsonb_build_object('start_minute',r.start_minute,'end_minute',r.end_minute,
      'hourly_centavos',r.hourly_centavos) order by r.start_minute) from private.schedule_rates r where r.window_id = w.id))
    order by w.start_minute), '[]'::jsonb)
  from private.schedule_windows w where w.venue_id = target
    and (w.weekday = day_number or w.exception_date = dated);
$$;
create function private.schedule_json(target uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('weekly', (select jsonb_agg(private.schedule_window_json(target,d,null) order by d) from generate_series(0,6) d),
    'exceptions', coalesce((select jsonb_agg(jsonb_build_object('date',e.local_date,
      'windows',private.schedule_window_json(target,null,e.local_date)) order by e.local_date)
      from private.schedule_exceptions e where e.venue_id = target),'[]'::jsonb));
$$;

-- Bounded internal resolver for later inventory/pricing transactions. Not public availability.
create function private.resolve_venue_schedule(target uuid, first_date date, day_count integer) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  if first_date is null or day_count is null or day_count not between 1 and 31
    or first_date < date '2000-01-01' or first_date + (day_count - 1) > date '2099-12-31' then
    raise exception 'Invalid date range' using errcode = '22023', hint = 'invalid_input';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'starts_at', ((first_date + d)::timestamp + b.start_minute * interval '1 minute') at time zone 'Asia/Manila',
    'ends_at', ((first_date + d)::timestamp + b.end_minute * interval '1 minute') at time zone 'Asia/Manila',
    'hourly_centavos',b.hourly_centavos) order by d,b.start_minute)
    from generate_series(0,day_count - 1) d cross join lateral private.schedule_bands(target,first_date+d) b),'[]'::jsonb);
end;
$$;

-- Same listing lock as a save: prevents a mixed version/rules/intervals response.
create function public.venue_schedule_read(actor_user_id uuid, target_venue_id uuid, start_date date, days integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare version bigint; resolved jsonb;
begin
  perform private.require_schedule_editor(actor_user_id,target_venue_id);
  select s.revision into version from private.venue_schedules s where s.venue_id = target_venue_id;
  resolved := private.resolve_venue_schedule(target_venue_id,start_date,days);
  return jsonb_build_object('venue_id',target_venue_id,'revision',version::text,
    'schedule',case when version is null then null else private.schedule_json(target_venue_id) end,'intervals',resolved);
end;
$$;

create function public.venue_schedule_save(actor_user_id uuid, target_venue_id uuid, expected_revision text, schedule_input jsonb) returns jsonb
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
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
    values(actor_user_id,target_venue_id,'schedule.update');
  return jsonb_build_object('venue_id',target_venue_id,'revision',version::text,'schedule',private.schedule_json(target_venue_id),'intervals','[]'::jsonb);
end;
$$;

revoke all on function private.require_schedule_editor(uuid,uuid), private.schedule_minute(jsonb),
  private.schedule_insert_windows(uuid,integer,date,jsonb), private.schedule_bands(uuid,date,boolean),
  private.schedule_window_json(uuid,integer,date), private.schedule_json(uuid), private.resolve_venue_schedule(uuid,date,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.venue_schedule_read(uuid,uuid,date,integer), public.venue_schedule_save(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.venue_schedule_read(uuid,uuid,date,integer), public.venue_schedule_save(uuid,uuid,text,jsonb) to service_role;
notify pgrst, 'reload schema';
