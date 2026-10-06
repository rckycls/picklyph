-- Directory curation only. No ownership, evidence, inventory or booking grants.
create table private.directory_import_refs (
  reference text primary key check (char_length(reference) between 1 and 120 and reference = btrim(reference)),
  venue_id uuid not null unique references public.venues(id) on delete cascade,
  original_input jsonb not null,
  created_at timestamptz not null default now()
);
alter table private.directory_import_refs enable row level security;
revoke all on private.directory_import_refs from public, anon, authenticated, service_role;

-- Hold the assignment until the command commits, so revocation cannot race a write.
create function private.require_directory_admin(actor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from private.account_roles r where r.user_id = actor_id and r.role = 'admin' for share;
  if not found then raise exception 'Administrator authorization required' using errcode = '42501'; end if;
end;
$$;

create function private.validate_directory_input(venue_input jsonb, court_inputs jsonb) returns void
language plpgsql set search_path = '' as $$
declare field text; max_length integer; court jsonb; court_id uuid;
begin
  if jsonb_typeof(venue_input) is distinct from 'object' then
    raise exception 'Invalid venue fields' using errcode = '22023';
  end if;
  if not venue_input ?& array['name','address_line','city','province','latitude','longitude']
    or (select count(*) from jsonb_object_keys(venue_input)) <> 6 then
    raise exception 'Unexpected or missing venue fields' using errcode = '22023';
  end if;
  foreach field in array array['name','address_line','city','province'] loop
    max_length := case field when 'name' then 120 when 'address_line' then 240 else 80 end;
    if jsonb_typeof(venue_input -> field) is distinct from 'string'
      or char_length(btrim(venue_input ->> field)) not between 1 and max_length then
      raise exception 'Invalid venue text' using errcode = '22023';
    end if;
  end loop;
  if jsonb_typeof(venue_input -> 'latitude') is distinct from 'number'
    or jsonb_typeof(venue_input -> 'longitude') is distinct from 'number' then
    raise exception 'Coordinates must be numbers' using errcode = '22023';
  end if;
  if (venue_input ->> 'latitude')::numeric not between -90 and 90
    or (venue_input ->> 'longitude')::numeric not between -180 and 180 then
    raise exception 'Invalid coordinates' using errcode = '22023';
  end if;
  if jsonb_typeof(court_inputs) is distinct from 'array' then
    raise exception 'Courts must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(court_inputs) > 40 then raise exception 'Too many courts' using errcode = '22023'; end if;
  for court in select value from jsonb_array_elements(court_inputs) loop
    if jsonb_typeof(court) is distinct from 'object' then raise exception 'Invalid court fields' using errcode = '22023'; end if;
    if not court ?& array['id','name','surface','is_indoor','is_covered','status']
      or (select count(*) from jsonb_object_keys(court)) <> 6 then
      raise exception 'Unexpected or missing court fields' using errcode = '22023';
    end if;
    if jsonb_typeof(court -> 'id') not in ('null','string') then raise exception 'Invalid court identifier' using errcode = '22023'; end if;
    begin court_id := (court ->> 'id')::uuid;
    exception when invalid_text_representation then raise exception 'Invalid court identifier' using errcode = '22023'; end;
    if jsonb_typeof(court -> 'name') is distinct from 'string' or char_length(btrim(court ->> 'name')) not between 1 and 80
      or jsonb_typeof(court -> 'surface') not in ('null','string')
      or (court ->> 'surface' is not null and court ->> 'surface' not in ('hard','synthetic','other'))
      or jsonb_typeof(court -> 'is_indoor') is distinct from 'boolean'
      or jsonb_typeof(court -> 'is_covered') is distinct from 'boolean'
      or jsonb_typeof(court -> 'status') is distinct from 'string' or court ->> 'status' not in ('active','inactive') then
      raise exception 'Invalid court details' using errcode = '22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(court_inputs) c group by btrim(c ->> 'name') having count(*) > 1)
    or exists(select 1 from jsonb_array_elements(court_inputs) c where c ->> 'id' is not null group by (c ->> 'id')::uuid having count(*) > 1) then
    raise exception 'Duplicate court name or identifier' using errcode = '22023';
  end if;
end;
$$;

create function private.directory_listing(venue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select (to_jsonb(v) - 'location') || jsonb_build_object('courts',
    coalesce((select jsonb_agg(to_jsonb(c) order by c.name, c.id) from public.courts c where c.venue_id = v.id), '[]'::jsonb))
  from public.venues v where v.id = $1;
$$;

create function public.directory_admin_read(actor_user_id uuid, target_venue_id uuid default null, after_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; result jsonb;
begin
  perform private.require_directory_admin(actor_user_id);
  select array_agg(v.id order by v.id) into ids from (
    select v.id from public.venues v where (target_venue_id is null or v.id = target_venue_id)
      and (after_id is null or v.id > after_id) order by v.id limit 101
  ) v;
  select coalesce(jsonb_agg(private.directory_listing(id) order by id), '[]'::jsonb) into result
    from unnest(ids[1:100]) id;
  return jsonb_build_object('items', result, 'next_cursor', case when cardinality(ids) > 100 then ids[100] else null end);
end;
$$;

create function public.directory_admin_save(actor_user_id uuid, target_venue_id uuid, expected_updated_at timestamptz,
  venue_input jsonb, court_inputs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved_venue_id uuid := target_venue_id; current_version timestamptz; court jsonb; court_id uuid; current_status public.venue_publication_status;
begin
  perform private.require_directory_admin(actor_user_id);
  perform private.validate_directory_input(venue_input, court_inputs);
  if saved_venue_id is null then
    if expected_updated_at is not null or exists(select 1 from jsonb_array_elements(court_inputs) c where c ->> 'id' is not null) then
      raise exception 'Invalid new draft' using errcode = '22023';
    end if;
    insert into public.venues(name,address_line,city,province,latitude,longitude)
      values (btrim(venue_input ->> 'name'),btrim(venue_input ->> 'address_line'),btrim(venue_input ->> 'city'),
        btrim(venue_input ->> 'province'),(venue_input ->> 'latitude')::double precision,(venue_input ->> 'longitude')::double precision)
      returning id into saved_venue_id;
  else
    select v.updated_at, v.publication_status into current_version, current_status from public.venues v where v.id = saved_venue_id for update;
    if not found then raise exception 'Listing not found' using errcode = 'P0002'; end if;
    if expected_updated_at is null then raise exception 'Listing version required' using errcode = '22023'; end if;
    if current_version <> expected_updated_at then raise exception 'Listing changed; reload before saving' using errcode = '40001'; end if;
    if exists(select 1 from jsonb_array_elements(court_inputs) c where c ->> 'id' is not null
      and not exists(select 1 from public.courts t where t.id = (c ->> 'id')::uuid and t.venue_id = saved_venue_id)) then
      raise exception 'Court does not belong to this venue' using errcode = '22023';
    end if;
    update public.venues v set name=btrim(venue_input ->> 'name'),address_line=btrim(venue_input ->> 'address_line'),
      city=btrim(venue_input ->> 'city'),province=btrim(venue_input ->> 'province'),
      latitude=(venue_input ->> 'latitude')::double precision,longitude=(venue_input ->> 'longitude')::double precision where v.id=saved_venue_id;
  end if;
  -- Existing courts are updated in place. Omitted courts, evidence and ownership survive.
  for court in select value from jsonb_array_elements(court_inputs) loop
    court_id := (court ->> 'id')::uuid;
    if court_id is null then
      insert into public.courts(venue_id,name,surface,is_indoor,is_covered,status) values
        (saved_venue_id,btrim(court ->> 'name'),(court ->> 'surface')::public.court_surface,
         (court ->> 'is_indoor')::boolean,(court ->> 'is_covered')::boolean,(court ->> 'status')::public.court_status);
    else
      update public.courts c set name=btrim(court ->> 'name'),surface=(court ->> 'surface')::public.court_surface,
        is_indoor=(court ->> 'is_indoor')::boolean,is_covered=(court ->> 'is_covered')::boolean,
        status=(court ->> 'status')::public.court_status where c.id=court_id and c.venue_id=saved_venue_id;
    end if;
  end loop;
  if (select count(*) from public.courts c where c.venue_id=saved_venue_id) > 40 then raise exception 'Too many courts' using errcode = '22023'; end if;
  if current_status = 'approved' and not exists(select 1 from public.courts c where c.venue_id=saved_venue_id and c.status='active') then
    raise exception 'Published venues need an active court; unpublish first' using errcode = '22023';
  end if;
  return private.directory_listing(saved_venue_id);
end;
$$;

create function public.directory_admin_publish(actor_user_id uuid, target_venue_id uuid,
  expected_updated_at timestamptz, new_status public.venue_publication_status) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_version timestamptz;
begin
  perform private.require_directory_admin(actor_user_id);
  if new_status is null or expected_updated_at is null then raise exception 'Publication status and version required' using errcode = '22023'; end if;
  select v.updated_at into current_version from public.venues v where v.id=target_venue_id for update;
  if not found then raise exception 'Listing not found' using errcode = 'P0002'; end if;
  if current_version <> expected_updated_at then raise exception 'Listing changed; reload before publishing' using errcode = '40001'; end if;
  if new_status='approved' and not exists(select 1 from public.courts c where c.venue_id=target_venue_id and c.status='active') then
    raise exception 'Add an active court before publishing' using errcode = '22023';
  end if;
  update public.venues v set publication_status=new_status where v.id=target_venue_id;
  return private.directory_listing(target_venue_id);
end;
$$;

create function public.directory_admin_import(actor_user_id uuid, listings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare entry jsonb; ref text; existing_ref private.directory_import_refs%rowtype; saved jsonb; result jsonb := '[]';
begin
  perform private.require_directory_admin(actor_user_id);
  if jsonb_typeof(listings) is distinct from 'array' then raise exception 'Invalid import' using errcode = '22023'; end if;
  if jsonb_array_length(listings) not between 1 and 25 then raise exception 'Import 1 to 25 listings' using errcode = '22023'; end if;
  -- Validate the whole batch before writing any rows.
  for entry in select value from jsonb_array_elements(listings) loop
    if jsonb_typeof(entry) is distinct from 'object' then raise exception 'Invalid import entry' using errcode = '22023'; end if;
    if not entry ?& array['reference','venue','courts'] or (select count(*) from jsonb_object_keys(entry)) <> 3
      or jsonb_typeof(entry -> 'reference') is distinct from 'string' or char_length(btrim(entry ->> 'reference')) not between 1 and 120 then
      raise exception 'Invalid import reference or fields' using errcode = '22023';
    end if;
    perform private.validate_directory_input(entry -> 'venue', entry -> 'courts');
    if exists(select 1 from jsonb_array_elements(entry -> 'courts') c where c ->> 'id' is not null) then
      raise exception 'Imports cannot reuse court identifiers' using errcode = '22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(listings) e group by btrim(e ->> 'reference') having count(*) > 1) then
    raise exception 'Duplicate import references' using errcode = '22023';
  end if;
  -- Ordered transaction locks serialize retries/concurrent overlapping batches.
  for entry in select value from jsonb_array_elements(listings) order by btrim(value ->> 'reference') loop
    ref := btrim(entry ->> 'reference');
    perform pg_advisory_xact_lock(hashtextextended('pickly:directory-import:' || ref, 0));
    select r.* into existing_ref from private.directory_import_refs r where r.reference=ref;
    if found then
      if existing_ref.original_input <> entry then raise exception 'Import reference has different data; edit its listing instead' using errcode = '23505'; end if;
      result := result || jsonb_build_array(jsonb_build_object('reference',ref,'id',existing_ref.venue_id,'outcome','existing'));
    else
      saved := public.directory_admin_save(actor_user_id,null,null,entry -> 'venue',entry -> 'courts');
      insert into private.directory_import_refs(reference,venue_id,original_input) values (ref,(saved ->> 'id')::uuid,entry);
      result := result || jsonb_build_array(jsonb_build_object('reference',ref,'id',saved ->> 'id','outcome','created'));
    end if;
  end loop;
  return result;
end;
$$;

revoke all on function private.require_directory_admin(uuid), private.validate_directory_input(jsonb,jsonb),
  private.directory_listing(uuid) from public, anon, authenticated, service_role;
revoke all on function public.directory_admin_read(uuid,uuid,uuid), public.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb),
  public.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status), public.directory_admin_import(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.directory_admin_read(uuid,uuid,uuid), public.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb),
  public.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status), public.directory_admin_import(uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
