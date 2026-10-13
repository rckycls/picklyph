-- T53: public pre-launch court registration (apps/web). A court owner with no account pins a venue and
-- leaves contact details; each registration becomes a private, unclaimed draft listing plus a private row
-- holding the contact details and a keyed hash of a single-use claim code (redeemed in the app at launch, T54).
-- Nothing here publishes, links an owner, verifies a claim or makes anything bookable. Only the trusted
-- registration server (service_role) calls these commands; no client role can read or write registrations.

-- Pre-launch rows have no account, so their audit actor is the registration itself.
alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
    'directory.create', 'directory.update', 'directory.publish', 'directory.unpublish', 'directory.suspend', 'directory.import',
    'owner.create', 'owner.update', 'owner.photo_add', 'owner.photo_remove', 'schedule.update', 'policy.update',
    'allocation.block', 'allocation.release', 'schedule.court_update', 'session.create', 'session.cancel', 'directory.delete',
    'prelaunch.register', 'prelaunch.retire'));

create table private.venue_registrations (
  id uuid primary key,
  -- Client-generated per form submission: a retry with the same key returns the original registration.
  request_key uuid not null unique,
  venue_id uuid not null references public.venues(id),
  status text not null default 'open' check (status in ('open', 'erased')),
  owner_name text check (owner_name is null or (owner_name = btrim(owner_name)
    and char_length(owner_name) between 1 and 120 and owner_name !~ '[[:cntrl:]]')),
  email text check (email is null or (email = lower(btrim(email)) and char_length(email) between 3 and 254
    and email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$')),
  phone text check (phone is null or phone ~ '^\+639[0-9]{9}$'),
  role text not null check (role in ('owner', 'manager', 'staff')),
  note text check (private.valid_owner_note(note)),
  consent_at timestamptz not null,
  duplicates_acknowledged boolean not null,
  -- Reviewer-only snapshot (approved and draft listings nearby, other registrations' drafts included).
  -- The registrant only ever sees approved public listings.
  nearby_venue_ids uuid[] not null default '{}',
  -- HMAC-SHA256 (hex) of the claim code under the registration server's secret; the code itself is never stored.
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  code_version integer not null default 1 check (code_version between 1 and 1000),
  email_sent_at timestamptz,
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venue_registrations_open check (status <> 'open'
    or (owner_name is not null and email is not null and code_hash is not null and erased_at is null)),
  constraint venue_registrations_erased check (status <> 'erased'
    or (owner_name is null and email is null and phone is null and note is null and code_hash is null and erased_at is not null))
);
create unique index venue_registrations_code on private.venue_registrations (code_hash) where code_hash is not null;
create index venue_registrations_open_email on private.venue_registrations (email) where status = 'open';
create index venue_registrations_retention on private.venue_registrations ((coalesce(email_sent_at, created_at)), id) where status = 'open';
create index venue_registrations_venue on private.venue_registrations (venue_id);
create trigger venue_registrations_updated_at before update on private.venue_registrations
  for each row execute function private.set_updated_at();
alter table private.venue_registrations enable row level security;
revoke all on private.venue_registrations from public, anon, authenticated, service_role;

-- Contact and court fields (the venue object is checked by the T15 validator). Raises invalid_input.
create function private.validate_prelaunch_registration(registration jsonb) returns void
language plpgsql set search_path = '' as $$
declare courts jsonb;
begin
  if jsonb_typeof(registration) is distinct from 'object'
    or not registration ?& array['owner_name','email','phone','role','venue','courts','note','consent']
    or (select count(*) from jsonb_object_keys(registration)) <> 8 then
    raise exception 'Unexpected or missing registration fields' using errcode = '22023', hint = 'invalid_input';
  end if;
  if jsonb_typeof(registration -> 'owner_name') is distinct from 'string'
    or registration ->> 'owner_name' <> btrim(registration ->> 'owner_name')
    or char_length(registration ->> 'owner_name') not between 1 and 120 or registration ->> 'owner_name' ~ '[[:cntrl:]]'
    or jsonb_typeof(registration -> 'email') is distinct from 'string'
    or registration ->> 'email' <> lower(btrim(registration ->> 'email'))
    or char_length(registration ->> 'email') not between 3 and 254
    or registration ->> 'email' !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'
    or not (jsonb_typeof(registration -> 'phone') = 'null'
      or (jsonb_typeof(registration -> 'phone') = 'string' and registration ->> 'phone' ~ '^\+639[0-9]{9}$'))
    or jsonb_typeof(registration -> 'role') is distinct from 'string'
    or registration ->> 'role' not in ('owner', 'manager', 'staff')
    or not (jsonb_typeof(registration -> 'note') = 'null'
      or (jsonb_typeof(registration -> 'note') = 'string' and private.valid_owner_note(registration ->> 'note')))
    or registration -> 'consent' is distinct from 'true'::jsonb then
    raise exception 'Invalid contact details or consent' using errcode = '22023', hint = 'invalid_input';
  end if;
  perform private.validate_owner_venue_input(registration -> 'venue');
  courts := registration -> 'courts';
  if jsonb_typeof(courts) is distinct from 'object' or not courts ?& array['indoor','covered','surface']
    or (select count(*) from jsonb_object_keys(courts)) <> 3
    or jsonb_typeof(courts -> 'indoor') is distinct from 'boolean' or jsonb_typeof(courts -> 'covered') is distinct from 'boolean'
    or not (jsonb_typeof(courts -> 'surface') = 'null'
      or (jsonb_typeof(courts -> 'surface') = 'string' and courts ->> 'surface' in ('hard', 'synthetic', 'other'))) then
    raise exception 'Invalid court details' using errcode = '22023', hint = 'invalid_input';
  end if;
end;
$$;

-- What the registration server needs to send (or not send) the code email.
create function private.prelaunch_result(outcome text, item private.venue_registrations, send boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('outcome', outcome, 'registration_id', item.id, 'send', send,
    'code_version', item.code_version, 'venue_name', (select v.name from public.venues v where v.id = item.venue_id),
    'duplicates', '[]'::jsonb);
$$;

-- request_key/registration/code_hash come from the registration server after its Origin, Turnstile and rate
-- checks. Outcomes: created; existing (a retry: if the code email was never sent, the code rotates and the old
-- one stops working); duplicates (approved listings nearby, nothing written); limit (10 open registrations
-- for this email, nothing written). The server must answer created, existing and limit identically.
create function public.prelaunch_register(request_key uuid, registration jsonb, code_hash text,
  acknowledge_duplicates boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing private.venue_registrations; saved private.venue_registrations; venue jsonb; contact_email text;
  lat double precision; lng double precision; venue_name text; public_duplicates jsonb; nearby_ids uuid[];
  draft_id uuid; saved_id uuid := gen_random_uuid();
begin
  perform private.validate_prelaunch_registration(registration);
  if request_key is null or acknowledge_duplicates is null or code_hash is null or code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid registration request' using errcode = '22023', hint = 'invalid_input';
  end if;
  contact_email := registration ->> 'email';
  -- Serializes one address's registrations, so retries, rotation and the open cap cannot race.
  perform pg_advisory_xact_lock(hashtextextended('pickly:prelaunch:' || contact_email, 0));
  select r.* into existing from private.venue_registrations r where r.request_key = prelaunch_register.request_key for update;
  if found then
    if existing.email is distinct from contact_email then
      raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
    end if;
    if existing.status = 'open' and existing.email_sent_at is null then
      if exists (select 1 from private.venue_registrations r where r.code_hash = prelaunch_register.code_hash) then
        raise exception 'Claim code collision' using errcode = '23505', hint = 'code_collision';
      end if;
      update private.venue_registrations r set code_hash = prelaunch_register.code_hash, code_version = r.code_version + 1
        where r.id = existing.id returning r.* into saved;
      return private.prelaunch_result('existing', saved, true);
    end if;
    return private.prelaunch_result('existing', existing, false);
  end if;
  venue := registration -> 'venue';
  lat := (venue ->> 'latitude')::double precision;
  lng := (venue ->> 'longitude')::double precision;
  venue_name := venue ->> 'name';
  -- Approved listings nearby must be acknowledged first; drafts and other registrations are never revealed.
  public_duplicates := private.owner_public_duplicates(lat, lng, venue_name);
  if jsonb_array_length(public_duplicates) > 0 and not acknowledge_duplicates then
    return jsonb_build_object('outcome', 'duplicates', 'registration_id', null, 'send', false, 'code_version', null,
      'venue_name', venue_name, 'duplicates', public_duplicates);
  end if;
  if (select count(*) from private.venue_registrations r where r.email = contact_email and r.status = 'open') >= 10 then
    return jsonb_build_object('outcome', 'limit', 'registration_id', null, 'send', false, 'code_version', null,
      'venue_name', venue_name, 'duplicates', '[]'::jsonb);
  end if;
  if exists (select 1 from private.venue_registrations r where r.code_hash = prelaunch_register.code_hash) then
    raise exception 'Claim code collision' using errcode = '23505', hint = 'code_collision';
  end if;
  select coalesce(array_agg(n.id order by n.id), '{}') into nearby_ids from private.owner_nearby_venues(lat, lng, venue_name) n;
  insert into public.venues (name, address_line, city, province, latitude, longitude, publication_status, claim_status)
    values (venue_name, venue ->> 'address_line', venue ->> 'city', venue ->> 'province', lat, lng, 'draft', 'unclaimed')
    returning id into draft_id;
  insert into public.courts (venue_id, name, surface, is_indoor, is_covered)
    select draft_id, 'Court ' || n, (registration -> 'courts' ->> 'surface')::public.court_surface,
      (registration -> 'courts' ->> 'indoor')::boolean, (registration -> 'courts' ->> 'covered')::boolean
    from generate_series(1, (venue ->> 'court_count')::integer) n;
  insert into private.venue_registrations (id, request_key, venue_id, owner_name, email, phone, role, note, consent_at,
    duplicates_acknowledged, nearby_venue_ids, code_hash)
  values (saved_id, prelaunch_register.request_key, draft_id, registration ->> 'owner_name', contact_email,
    registration ->> 'phone', registration ->> 'role', registration ->> 'note', clock_timestamp(),
    acknowledge_duplicates, nearby_ids, prelaunch_register.code_hash)
  returning * into saved;
  -- Same transaction: an audit failure aborts the draft and the registration.
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (saved_id, draft_id, 'prelaunch.register');
  return private.prelaunch_result('created', saved, true);
end;
$$;

-- Records a delivered code email, only for the code version that was sent (a rotated code's late success is ignored).
create function public.prelaunch_email_sent(registration_id uuid, sent_version integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if registration_id is null or sent_version is null then
    raise exception 'Invalid delivery record' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.venue_registrations r set email_sent_at = clock_timestamp()
    where r.id = registration_id and r.code_version = sent_version and r.status = 'open';
  return found;
end;
$$;

-- T47 sweep plus T53: registrations still open 180 days after their last code email (or creation, if no email
-- was ever delivered) lose their contact details and code hash, and their still-draft listing is retired
-- (suspended, audited). Like other venue commands, the listing is locked before the registration.
create or replace function private.privacy_retention_sweep(batch_limit integer default 500) returns jsonb
language plpgsql set search_path = '' as $$
declare cleared integer; erased integer := 0; item record;
begin
  if batch_limit is null or batch_limit not between 1 and 10000 then
    raise exception 'Invalid batch limit' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.venue_reports r set details = null where r.id in (
    select x.id from private.venue_reports x
      where x.status <> 'open' and x.details is not null and x.reviewed_at < clock_timestamp() - interval '180 days'
      order by x.reviewed_at, x.id limit batch_limit for update skip locked);
  get diagnostics cleared = row_count;
  for item in select r.id, r.venue_id from private.venue_registrations r
    where r.status = 'open' and coalesce(r.email_sent_at, r.created_at) < clock_timestamp() - interval '180 days'
    order by coalesce(r.email_sent_at, r.created_at), r.id limit batch_limit loop
    perform 1 from public.venues v where v.id = item.venue_id for update;
    perform 1 from private.venue_registrations r where r.id = item.id and r.status = 'open'
      and coalesce(r.email_sent_at, r.created_at) < clock_timestamp() - interval '180 days' for update;
    continue when not found;
    update private.venue_registrations r set status = 'erased', owner_name = null, email = null, phone = null,
      note = null, code_hash = null, erased_at = clock_timestamp() where r.id = item.id;
    update public.venues v set publication_status = 'suspended' where v.id = item.venue_id and v.publication_status = 'draft';
    if found then
      insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (item.id, item.venue_id, 'prelaunch.retire');
    end if;
    erased := erased + 1;
  end loop;
  return jsonb_build_object('report_details', cleared, 'prelaunch_registrations', erased,
    'more', cleared = batch_limit or erased = batch_limit);
end;
$$;

-- A registration's listing keeps its history: it can be suspended, never deleted.
create or replace function private.directory_delete_blocker(target_venue_id uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from private.court_allocations a where a.venue_id = target_venue_id) then 'court_history'
    when exists (select 1 from private.open_play_sessions s where s.venue_id = target_venue_id) then 'session_history'
    when exists (select 1 from private.booking_cancellations b where b.venue_id = target_venue_id) then 'cancellations'
    when exists (select 1 from private.venue_owners o where o.venue_id = target_venue_id) then 'owner'
    when exists (select 1 from private.venue_claims c where c.venue_id = target_venue_id) then 'claim'
    when exists (select 1 from private.venue_submissions s where s.venue_id = target_venue_id or s.resolved_venue_id = target_venue_id) then 'submission'
    when exists (select 1 from private.venue_registrations r where r.venue_id = target_venue_id) then 'registration'
    when exists (select 1 from public.venue_photos p where p.venue_id = target_venue_id) then 'photos'
    when exists (select 1 from private.venue_reports r where r.venue_id = target_venue_id)
      or exists (select 1 from private.venue_moderation_suspensions m where m.venue_id = target_venue_id) then 'reports'
    when exists (select 1 from private.venue_merchants m where m.venue_id = target_venue_id) then 'merchant'
  end;
$$;

revoke all on function private.validate_prelaunch_registration(jsonb),
  private.prelaunch_result(text, private.venue_registrations, boolean),
  private.privacy_retention_sweep(integer), private.directory_delete_blocker(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prelaunch_register(uuid, jsonb, text, boolean), public.prelaunch_email_sent(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.prelaunch_register(uuid, jsonb, text, boolean), public.prelaunch_email_sent(uuid, integer)
  to service_role;
notify pgrst, 'reload schema';
