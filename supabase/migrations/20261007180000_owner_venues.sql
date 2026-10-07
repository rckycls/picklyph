-- T18: verified owners edit their own venue details, courts and public photos.
-- Pins, publication and claim status stay admin-only. Every write is a
-- service-only command that locks the listing and the owner link, then audits in
-- the same transaction. Schedules/rates are T19 and policies T20. Court
-- deactivation has no bookings to protect yet; T22 must add that check.

-- Public photo bucket. There are deliberately NO storage.objects policies for it:
-- client roles cannot upload, list, replace or delete objects. Anyone can fetch
-- an object by its public URL; the trusted server strips metadata, chooses an
-- unguessable name and uploads. Only approved venues' photo rows are readable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('venue-photos', 'venue-photos', true, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Directory information only: no uploader IDs or request IDs (those stay private).
create table public.venue_photos (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  storage_path text not null unique check (storage_path ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'),
  -- Display dimensions measured by the server (EXIF rotation applied).
  width integer not null check (width between 320 and 8192),
  height integer not null check (height between 320 and 8192),
  created_at timestamptz not null default now(),
  check (split_part(storage_path, '/', 1) = venue_id::text),
  check (width::bigint * height <= 25000000)
);
create index venue_photos_venue on public.venue_photos (venue_id, created_at, id);
alter table public.venue_photos enable row level security;
revoke all on public.venue_photos from public, anon, authenticated, service_role;
grant select on public.venue_photos to anon, authenticated, service_role;
create policy venue_photos_public_read on public.venue_photos for select to anon, authenticated
  using (exists (select 1 from public.venues v where v.id = venue_id and v.publication_status = 'approved'));

-- Retry-safe uploads. No FK on the uploader, like the audit tables (T47 retention).
create table private.venue_photo_requests (
  photo_id uuid primary key references public.venue_photos(id) on delete cascade,
  uploaded_by uuid not null,
  request_id uuid not null,
  unique (uploaded_by, request_id)
);
alter table private.venue_photo_requests enable row level security;
revoke all on private.venue_photo_requests from public, anon, authenticated, service_role;

-- Owner edits share the T12 per-venue history, so admins see them beside curation.
alter table private.directory_audit_events
  drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
    'directory.create', 'directory.update', 'directory.publish',
    'directory.unpublish', 'directory.suspend', 'directory.import',
    'owner.update', 'owner.photo_add', 'owner.photo_remove'));

-- Locks the listing first (the same order as admin saves and ownership review),
-- then the owner link, both until commit: revocation, suspension or a competing
-- edit cannot race this write. The unlocked check keeps non-owners from taking
-- a row lock at all.
create function private.require_venue_owner(actor_id uuid, target_venue_id uuid) returns public.venues
language plpgsql set search_path = '' as $$
declare listing public.venues;
begin
  if actor_id is null or target_venue_id is null or not exists (select 1 from private.venue_owners o
    where o.user_id = actor_id and o.venue_id = target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  end if;
  select v.* into listing from public.venues v where v.id = target_venue_id for update;
  perform 1 from private.venue_owners o where o.user_id = actor_id and o.venue_id = target_venue_id for share;
  if not found then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  end if;
  if listing.publication_status <> 'approved' or listing.claim_status <> 'verified' then
    raise exception 'Listing unavailable for editing' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  return listing;
end;
$$;

-- Everything an owner edits, including inactive courts. No owner/claim IDs.
create function private.owner_venue_listing(target_venue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', v.id, 'name', v.name, 'address_line', v.address_line, 'city', v.city,
    'province', v.province, 'latitude', v.latitude, 'longitude', v.longitude,
    'publication_status', v.publication_status, 'claim_status', v.claim_status, 'updated_at', v.updated_at,
    'courts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'venue_id', c.venue_id, 'name', c.name,
        'surface', c.surface, 'is_indoor', c.is_indoor, 'is_covered', c.is_covered, 'status', c.status,
        'created_at', c.created_at, 'updated_at', c.updated_at) order by c.name, c.id)
      from public.courts c where c.venue_id = v.id), '[]'::jsonb),
    'photos', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'storage_path', p.storage_path,
        'width', p.width, 'height', p.height, 'created_at', p.created_at) order by p.created_at, p.id)
      from public.venue_photos p where p.venue_id = v.id), '[]'::jsonb))
  from public.venues v where v.id = target_venue_id;
$$;

-- Owner text must arrive normalized: trimmed, bounded, no control characters.
create function private.valid_owner_text(value jsonb, max_length integer) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'string' and value #>> '{}' = btrim(value #>> '{}')
    and char_length(value #>> '{}') between 1 and max_length and value #>> '{}' !~ '[[:cntrl:]]';
$$;

-- Every linked venue, including ones not editable right now, so the app can say why.
create function public.owner_venue_list(actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner_submitter(actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'city', v.city,
      'province', v.province, 'publication_status', v.publication_status, 'claim_status', v.claim_status,
      'editable', v.publication_status = 'approved' and v.claim_status = 'verified',
      'active_court_count', (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active'),
      'photo_count', (select count(*) from public.venue_photos p where p.venue_id = v.id)) order by v.name, v.id)
    from (select v.* from private.venue_owners o join public.venues v on v.id = o.venue_id
      where o.user_id = actor_user_id order by v.name, v.id limit 50) v), '[]'::jsonb);
end;
$$;

create function public.owner_venue_read(actor_user_id uuid, target_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if actor_user_id is null or target_venue_id is null or not exists (select 1 from private.venue_owners o
    where o.user_id = actor_user_id and o.venue_id = target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  end if;
  if not private.is_verified_venue_owner(actor_user_id, target_venue_id) then
    raise exception 'Listing unavailable for editing' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  return private.owner_venue_listing(target_venue_id);
end;
$$;

-- actor_user_id MUST come from a server-verified token, never request JSON.
-- Owners send name/address/city/province only; the pin stays as curated. Court
-- rules are T11's: in-place updates, omitted courts untouched, at most 40, a
-- published venue keeps an active court.
create function public.owner_venue_save(actor_user_id uuid, target_venue_id uuid, expected_updated_at timestamptz,
  venue_input jsonb, court_inputs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare listing public.venues; court jsonb; court_id uuid;
begin
  listing := private.require_venue_owner(actor_user_id, target_venue_id);
  if jsonb_typeof(venue_input) is distinct from 'object'
    or not venue_input ?& array['name','address_line','city','province']
    or (select count(*) from jsonb_object_keys(venue_input)) <> 4
    or not private.valid_owner_text(venue_input -> 'name', 120)
    or not private.valid_owner_text(venue_input -> 'address_line', 240)
    or not private.valid_owner_text(venue_input -> 'city', 80)
    or not private.valid_owner_text(venue_input -> 'province', 80)
    or jsonb_typeof(court_inputs) is distinct from 'array'
    or exists (select 1 from jsonb_array_elements(court_inputs) c
      where jsonb_typeof(c) <> 'object' or not private.valid_owner_text(c -> 'name', 80)) then
    raise exception 'Invalid venue details' using errcode = '22023', hint = 'invalid_input';
  end if;
  begin
    -- T11 court validation, against the unchanged curated pin.
    perform private.validate_directory_input(venue_input
      || jsonb_build_object('latitude', listing.latitude, 'longitude', listing.longitude), court_inputs);
  exception when invalid_parameter_value then
    raise exception 'Invalid courts' using errcode = '22023', hint = 'invalid_input';
  end;
  if expected_updated_at is null then
    raise exception 'Listing version required' using errcode = '22023', hint = 'invalid_input';
  end if;
  if listing.updated_at <> expected_updated_at then
    raise exception 'Listing changed; reload before saving' using errcode = '40001', hint = 'version_conflict';
  end if;
  if exists (select 1 from jsonb_array_elements(court_inputs) c where c ->> 'id' is not null
    and not exists (select 1 from public.courts t where t.id = (c ->> 'id')::uuid and t.venue_id = target_venue_id)) then
    raise exception 'Court does not belong to this venue' using errcode = '22023', hint = 'invalid_input';
  end if;
  update public.venues v set name = venue_input ->> 'name', address_line = venue_input ->> 'address_line',
    city = venue_input ->> 'city', province = venue_input ->> 'province' where v.id = target_venue_id;
  begin
    for court in select value from jsonb_array_elements(court_inputs) loop
      court_id := (court ->> 'id')::uuid;
      if court_id is null then
        insert into public.courts (venue_id, name, surface, is_indoor, is_covered, status) values
          (target_venue_id, court ->> 'name', (court ->> 'surface')::public.court_surface,
           (court ->> 'is_indoor')::boolean, (court ->> 'is_covered')::boolean, (court ->> 'status')::public.court_status);
      else
        update public.courts c set name = court ->> 'name', surface = (court ->> 'surface')::public.court_surface,
          is_indoor = (court ->> 'is_indoor')::boolean, is_covered = (court ->> 'is_covered')::boolean,
          status = (court ->> 'status')::public.court_status where c.id = court_id and c.venue_id = target_venue_id;
      end if;
    end loop;
  exception when unique_violation then
    raise exception 'Another court already has that name' using errcode = '23505', hint = 'duplicate_court';
  end;
  if (select count(*) from public.courts c where c.venue_id = target_venue_id) > 40 then
    raise exception 'Too many courts' using errcode = '22023', hint = 'too_many_courts';
  end if;
  if not exists (select 1 from public.courts c where c.venue_id = target_venue_id and c.status = 'active') then
    raise exception 'Published venues need an active court' using errcode = '22023', hint = 'active_court_required';
  end if;
  -- Same transaction: an audit failure aborts the edit.
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
    values (actor_user_id, target_venue_id, 'owner.update');
  return private.owner_venue_listing(target_venue_id);
end;
$$;

-- storage_ref must be an object the trusted server just uploaded under the venue's
-- folder. Repeating a request returns 'existing' (the server then deletes its new
-- upload). Photos don't change the listing version: they never conflict with a
-- details edit, and the listing lock serializes the count check.
create function public.owner_venue_photo_add(actor_user_id uuid, target_venue_id uuid, photo_request_id uuid,
  storage_ref text, photo_width integer, photo_height integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing_venue uuid; saved_id uuid;
begin
  perform private.require_venue_owner(actor_user_id, target_venue_id);
  if photo_request_id is null then
    raise exception 'Invalid photo' using errcode = '22023', hint = 'invalid_input';
  end if;
  select p.venue_id into existing_venue from private.venue_photo_requests r
    join public.venue_photos p on p.id = r.photo_id
    where r.uploaded_by = actor_user_id and r.request_id = photo_request_id;
  if found then
    if existing_venue <> target_venue_id then
      raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
    end if;
    return jsonb_build_object('outcome', 'existing', 'venue', private.owner_venue_listing(target_venue_id));
  end if;
  if storage_ref is null or storage_ref !~ ('^' || target_venue_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$')
    or photo_width is null or photo_height is null or photo_width not between 320 and 8192
    or photo_height not between 320 and 8192 or photo_width::bigint * photo_height > 25000000 then
    raise exception 'Invalid photo' using errcode = '22023', hint = 'invalid_photo';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'venue-photos' and o.name = storage_ref)
    or exists (select 1 from public.venue_photos p where p.storage_path = storage_ref) then
    raise exception 'Photo upload not found' using errcode = '22023', hint = 'invalid_photo';
  end if;
  if (select count(*) from public.venue_photos p where p.venue_id = target_venue_id) >= 6 then
    raise exception 'Photo limit reached' using errcode = 'P0001', hint = 'too_many_photos';
  end if;
  insert into public.venue_photos (venue_id, storage_path, width, height)
    values (target_venue_id, storage_ref, photo_width, photo_height) returning id into saved_id;
  insert into private.venue_photo_requests (photo_id, uploaded_by, request_id)
    values (saved_id, actor_user_id, photo_request_id);
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
    values (actor_user_id, target_venue_id, 'owner.photo_add');
  return jsonb_build_object('outcome', 'created', 'venue', private.owner_venue_listing(target_venue_id));
end;
$$;

-- Retry-safe: an already-removed photo returns removed_path null and no audit row.
-- The server deletes the returned object after this transaction commits.
create function public.owner_venue_photo_remove(actor_user_id uuid, target_venue_id uuid, target_photo_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare removed text;
begin
  perform private.require_venue_owner(actor_user_id, target_venue_id);
  if target_photo_id is null then
    raise exception 'Invalid photo' using errcode = '22023', hint = 'invalid_input';
  end if;
  delete from public.venue_photos p where p.id = target_photo_id and p.venue_id = target_venue_id
    returning p.storage_path into removed;
  if removed is not null then
    insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
      values (actor_user_id, target_venue_id, 'owner.photo_remove');
  end if;
  return jsonb_build_object('removed_path', removed, 'venue', private.owner_venue_listing(target_venue_id));
end;
$$;

revoke all on function private.require_venue_owner(uuid, uuid), private.owner_venue_listing(uuid),
  private.valid_owner_text(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.owner_venue_list(uuid), public.owner_venue_read(uuid, uuid),
  public.owner_venue_save(uuid, uuid, timestamptz, jsonb, jsonb),
  public.owner_venue_photo_add(uuid, uuid, uuid, text, integer, integer),
  public.owner_venue_photo_remove(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.owner_venue_list(uuid), public.owner_venue_read(uuid, uuid),
  public.owner_venue_save(uuid, uuid, timestamptz, jsonb, jsonb),
  public.owner_venue_photo_add(uuid, uuid, uuid, text, integer, integer),
  public.owner_venue_photo_remove(uuid, uuid, uuid) to service_role;
notify pgrst, 'reload schema';
