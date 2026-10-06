-- T15: owner pin submissions and ownership claims with private evidence.
-- Records are reviewable only. Nothing here publishes, verifies a claim, changes
-- public claim status, links owners or assigns roles; review/approval is T17.

-- Private evidence bucket. There are deliberately NO storage.objects policies for
-- it: client roles cannot upload, list or read any object. The trusted server
-- uploads under server-chosen paths; reviewers will get server-issued access.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('owner-evidence', 'owner-evidence', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Claims on existing approved listings (T05 table). request_id makes retries
-- idempotent; the default only serves trusted fixture/operator inserts.
alter table private.venue_claims
  add column request_id uuid not null default gen_random_uuid(),
  add column note text check (note is null or (note = btrim(note) and char_length(note) between 1 and 500));
alter table private.venue_claims
  add constraint venue_claims_request unique (claimant_user_id, request_id),
  add constraint venue_claims_evidence unique (evidence_path);
create unique index venue_claims_one_pending on private.venue_claims (venue_id, claimant_user_id) where status = 'pending';
create index venue_claims_claimant on private.venue_claims (claimant_user_id, created_at desc);
-- Writes go through the audited command below, including for service_role.
revoke insert, update, delete, truncate on private.venue_claims from service_role;

-- Proposed missing venues. Stays private until T17 review; never a draft listing.
create table private.venue_submissions (
  id uuid primary key default gen_random_uuid(),
  submitter_user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  address_line text not null check (address_line = btrim(address_line) and char_length(address_line) between 1 and 240),
  city text not null check (city = btrim(city) and char_length(city) between 1 and 80),
  province text not null check (province = btrim(province) and char_length(province) between 1 and 80),
  -- Generous Philippines box; the directory itself is PH-only.
  latitude double precision not null check (latitude between 4 and 21.5),
  longitude double precision not null check (longitude between 116 and 127),
  location extensions.geometry(Point, 4326) generated always as
    (extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)) stored,
  court_count integer not null check (court_count between 1 and 40),
  evidence_path text not null unique check (char_length(evidence_path) between 1 and 200),
  note text check (note is null or (note = btrim(note) and char_length(note) between 1 and 500)),
  duplicates_acknowledged boolean not null,
  -- Reviewer-only snapshot at submission time (approved/draft venues and other
  -- pending submissions nearby). Clients only ever see approved public venues.
  nearby_venue_ids uuid[] not null default '{}',
  nearby_submission_ids uuid[] not null default '{}',
  status private.claim_review_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submitter_user_id, request_id)
);
create index venue_submissions_pending_location on private.venue_submissions using gist (location) where status = 'pending';
create index venue_submissions_submitter on private.venue_submissions (submitter_user_id, created_at desc);
create trigger venue_submissions_updated_at before update on private.venue_submissions
  for each row execute function private.set_updated_at();
alter table private.venue_submissions enable row level security;
revoke all on private.venue_submissions from public, anon, authenticated, service_role;

-- Same immutable/no-FK pattern as T12: history survives account/venue deletion.
-- Retention/account deletion belongs to T47.
create table private.ownership_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null,
  action text not null check (action in ('claim.submit', 'venue.submit')),
  subject_id uuid not null,
  target_venue_id uuid,
  occurred_at timestamptz not null default clock_timestamp(),
  check ((action = 'claim.submit') = (target_venue_id is not null))
);
create index ownership_audit_events_actor on private.ownership_audit_events (actor_user_id, id);
alter table private.ownership_audit_events enable row level security;
revoke all on private.ownership_audit_events from public, anon, authenticated, service_role;
revoke all on sequence private.ownership_audit_events_id_seq from public, anon, authenticated, service_role;

-- A real account, locked until commit so deletion cannot race the insert.
create function private.require_owner_submitter(actor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.profiles p where p.id = actor_id for share;
  if not found then
    raise exception 'Signed-in account required' using errcode = '42501', hint = 'actor_required';
  end if;
end;
$$;

create function private.valid_owner_note(note text) returns boolean
language sql immutable set search_path = '' as $$
  select note is null or (note = btrim(note) and char_length(note) between 1 and 500
    and note !~ '[\x01-\x09\x0b-\x1f\x7f]');
$$;

-- Server-chosen object under the actor's own folder that the server actually
-- uploaded, never reused across submissions.
create function private.require_owner_evidence(actor_id uuid, evidence_ref text) returns void
language plpgsql set search_path = '' as $$
begin
  if evidence_ref is null or evidence_ref !~ ('^' || actor_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$') then
    raise exception 'Invalid evidence reference' using errcode = '22023', hint = 'invalid_evidence';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'owner-evidence' and o.name = evidence_ref) then
    raise exception 'Evidence upload not found' using errcode = '22023', hint = 'invalid_evidence';
  end if;
  if exists (select 1 from private.venue_claims c where c.evidence_path = evidence_ref)
    or exists (select 1 from private.venue_submissions s where s.evidence_path = evidence_ref) then
    raise exception 'Evidence already used' using errcode = '23505', hint = 'invalid_evidence';
  end if;
end;
$$;

-- Bounded review queue per account (claims + new venues).
create function private.require_owner_pending_capacity(actor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from private.venue_claims c where c.claimant_user_id = actor_id and c.status = 'pending')
    + (select count(*) from private.venue_submissions s where s.submitter_user_id = actor_id and s.status = 'pending') >= 5 then
    raise exception 'Too many submissions awaiting review' using errcode = 'P0001', hint = 'too_many_pending';
  end if;
end;
$$;

create function private.validate_owner_venue_input(venue_input jsonb) returns void
language plpgsql set search_path = '' as $$
declare field text; max_length integer;
begin
  if jsonb_typeof(venue_input) is distinct from 'object'
    or not venue_input ?& array['name','address_line','city','province','latitude','longitude','court_count']
    or (select count(*) from jsonb_object_keys(venue_input)) <> 7 then
    raise exception 'Unexpected or missing venue fields' using errcode = '22023', hint = 'invalid_input';
  end if;
  foreach field in array array['name','address_line','city','province'] loop
    max_length := case field when 'name' then 120 when 'address_line' then 240 else 80 end;
    if jsonb_typeof(venue_input -> field) is distinct from 'string'
      or venue_input ->> field <> btrim(venue_input ->> field)
      or char_length(venue_input ->> field) not between 1 and max_length
      or venue_input ->> field ~ '[[:cntrl:]]' then
      raise exception 'Invalid venue text' using errcode = '22023', hint = 'invalid_input';
    end if;
  end loop;
  -- Type checks first, so a cast can never raise a different error.
  if jsonb_typeof(venue_input -> 'latitude') is distinct from 'number'
    or jsonb_typeof(venue_input -> 'longitude') is distinct from 'number'
    or jsonb_typeof(venue_input -> 'court_count') is distinct from 'number'
    or venue_input ->> 'court_count' !~ '^[0-9]{1,2}$' then
    raise exception 'Invalid pin or court count' using errcode = '22023', hint = 'invalid_input';
  end if;
  if (venue_input ->> 'latitude')::numeric not between 4 and 21.5
    or (venue_input ->> 'longitude')::numeric not between 116 and 127 then
    raise exception 'Pin must be in the Philippines' using errcode = '22023', hint = 'invalid_input';
  end if;
  if (venue_input ->> 'court_count')::integer not between 1 and 40 then
    raise exception 'Court count must be 1 to 40' using errcode = '22023', hint = 'invalid_input';
  end if;
end;
$$;

-- Approved/draft venues within 150 m, or a similar name within 2 km. Callers
-- decide what to reveal; suspended listings are excluded.
create function private.owner_nearby_venues(lat double precision, lng double precision, proposed_name text)
returns table (id uuid, name text, address_line text, city text, province text,
  claim_status public.venue_claim_status, publication_status public.venue_publication_status, distance_m integer)
language sql stable set search_path = '' as $$
  with origin as (select extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326) as g)
  select v.id, v.name, v.address_line, v.city, v.province, v.claim_status, v.publication_status,
    round(extensions.st_distance(v.location::extensions.geography, o.g::extensions.geography))::integer
  from public.venues v, origin o
  where v.publication_status in ('approved', 'draft')
    and v.location operator(extensions.&&) extensions.st_expand(o.g, 0.03)
    and (extensions.st_dwithin(v.location::extensions.geography, o.g::extensions.geography, 150)
      or (proposed_name is not null
        and extensions.st_dwithin(v.location::extensions.geography, o.g::extensions.geography, 2000)
        and extensions.similarity(lower(v.name), lower(proposed_name)) >= 0.5))
  order by 8, 1
  limit 10;
$$;

create function private.owner_public_duplicates(lat double precision, lng double precision, proposed_name text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name, 'address_line', n.address_line,
    'city', n.city, 'province', n.province, 'claim_status', n.claim_status, 'distance_m', n.distance_m)
    order by n.distance_m, n.id), '[]'::jsonb)
  from private.owner_nearby_venues(lat, lng, proposed_name) n
  where n.publication_status = 'approved';
$$;

-- The only shape returned to the submitter: no evidence path, note, reviewer
-- snapshot or other claimants.
create function private.owner_submission_item(subject_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('id', c.id, 'kind', 'claim', 'status', c.status, 'venue_id', c.venue_id,
       'name', v.name, 'city', v.city, 'created_at', c.created_at)
     from private.venue_claims c join public.venues v on v.id = c.venue_id where c.id = subject_id),
    (select jsonb_build_object('id', s.id, 'kind', 'venue', 'status', s.status, 'venue_id', null,
       'name', s.name, 'city', s.city, 'created_at', s.created_at)
     from private.venue_submissions s where s.id = subject_id));
$$;

create function public.owner_duplicate_candidates(actor_user_id uuid, latitude double precision,
  longitude double precision, proposed_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner_submitter(actor_user_id);
  if latitude is null or longitude is null or latitude not between 4 and 21.5 or longitude not between 116 and 127
    or (proposed_name is not null and (proposed_name <> btrim(proposed_name) or char_length(proposed_name) not between 1 and 120)) then
    raise exception 'Invalid duplicate check' using errcode = '22023', hint = 'invalid_input';
  end if;
  return private.owner_public_duplicates(latitude, longitude, proposed_name);
end;
$$;

-- actor_user_id MUST come from a server-verified token, never request JSON.
create function public.owner_submit_claim(actor_user_id uuid, submission_request_id uuid, target_venue_id uuid,
  evidence_ref text, claim_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare existing private.venue_claims%rowtype; listing record; saved_id uuid;
begin
  perform private.require_owner_submitter(actor_user_id);
  if submission_request_id is null or target_venue_id is null or not private.valid_owner_note(claim_note) then
    raise exception 'Invalid claim' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- Serializes this account's commands so retry, pending and cap checks cannot race.
  perform pg_advisory_xact_lock(hashtextextended('pickly:owner-submit:' || actor_user_id::text, 0));
  select c.* into existing from private.venue_claims c
    where c.claimant_user_id = actor_user_id and c.request_id = submission_request_id;
  if found then
    if existing.venue_id <> target_venue_id then
      raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
    end if;
    return jsonb_build_object('outcome', 'existing', 'submission', private.owner_submission_item(existing.id), 'duplicates', '[]'::jsonb);
  end if;
  if exists (select 1 from private.venue_submissions s
    where s.submitter_user_id = actor_user_id and s.request_id = submission_request_id) then
    raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end if;
  select v.publication_status, v.claim_status into listing from public.venues v where v.id = target_venue_id for share;
  if not found or listing.publication_status <> 'approved' then
    raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
  end if;
  if listing.claim_status = 'verified' then
    raise exception 'Listing already has a verified owner' using errcode = '23505', hint = 'already_verified';
  end if;
  if exists (select 1 from private.venue_claims c where c.venue_id = target_venue_id
    and c.claimant_user_id = actor_user_id and c.status = 'pending') then
    raise exception 'Claim already awaiting review' using errcode = '23505', hint = 'already_pending';
  end if;
  perform private.require_owner_pending_capacity(actor_user_id);
  perform private.require_owner_evidence(actor_user_id, evidence_ref);
  insert into private.venue_claims (venue_id, claimant_user_id, evidence_path, request_id, note)
    values (target_venue_id, actor_user_id, evidence_ref, submission_request_id, claim_note)
    returning id into saved_id;
  -- Same transaction: an audit failure aborts the claim.
  insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
    values (actor_user_id, 'claim.submit', saved_id, target_venue_id);
  return jsonb_build_object('outcome', 'created', 'submission', private.owner_submission_item(saved_id), 'duplicates', '[]'::jsonb);
end;
$$;

create function public.owner_submit_venue(actor_user_id uuid, submission_request_id uuid, venue_input jsonb,
  evidence_ref text, submission_note text, acknowledge_duplicates boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing_id uuid; saved_id uuid; lat double precision; lng double precision; venue_name text;
  public_duplicates jsonb; nearby_ids uuid[]; nearby_pending uuid[];
begin
  perform private.require_owner_submitter(actor_user_id);
  perform private.validate_owner_venue_input(venue_input);
  if submission_request_id is null or acknowledge_duplicates is null or not private.valid_owner_note(submission_note) then
    raise exception 'Invalid submission' using errcode = '22023', hint = 'invalid_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pickly:owner-submit:' || actor_user_id::text, 0));
  select s.id into existing_id from private.venue_submissions s
    where s.submitter_user_id = actor_user_id and s.request_id = submission_request_id;
  if found then
    return jsonb_build_object('outcome', 'existing', 'submission', private.owner_submission_item(existing_id), 'duplicates', '[]'::jsonb);
  end if;
  if exists (select 1 from private.venue_claims c
    where c.claimant_user_id = actor_user_id and c.request_id = submission_request_id) then
    raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end if;
  lat := (venue_input ->> 'latitude')::double precision;
  lng := (venue_input ->> 'longitude')::double precision;
  venue_name := venue_input ->> 'name';
  -- Public listings nearby must be acknowledged; nothing is written until then.
  public_duplicates := private.owner_public_duplicates(lat, lng, venue_name);
  if jsonb_array_length(public_duplicates) > 0 and not acknowledge_duplicates then
    return jsonb_build_object('outcome', 'duplicates', 'submission', null, 'duplicates', public_duplicates);
  end if;
  if exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_user_id and s.status = 'pending'
    and extensions.st_dwithin(s.location::extensions.geography,
      extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography, 150)) then
    raise exception 'A submission for this place is already awaiting review' using errcode = '23505', hint = 'already_pending';
  end if;
  perform private.require_owner_pending_capacity(actor_user_id);
  perform private.require_owner_evidence(actor_user_id, evidence_ref);
  select coalesce(array_agg(n.id order by n.id), '{}') into nearby_ids from private.owner_nearby_venues(lat, lng, venue_name) n;
  select coalesce(array_agg(s.id order by s.id), '{}') into nearby_pending from private.venue_submissions s
    where s.status = 'pending' and s.submitter_user_id <> actor_user_id
      and extensions.st_dwithin(s.location::extensions.geography,
        extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography, 150);
  insert into private.venue_submissions (submitter_user_id, request_id, name, address_line, city, province,
    latitude, longitude, court_count, evidence_path, note, duplicates_acknowledged, nearby_venue_ids, nearby_submission_ids)
  values (actor_user_id, submission_request_id, venue_name, venue_input ->> 'address_line', venue_input ->> 'city',
    venue_input ->> 'province', lat, lng, (venue_input ->> 'court_count')::integer, evidence_ref, submission_note,
    acknowledge_duplicates, nearby_ids, nearby_pending)
  returning id into saved_id;
  insert into private.ownership_audit_events (actor_user_id, action, subject_id)
    values (actor_user_id, 'venue.submit', saved_id);
  return jsonb_build_object('outcome', 'created', 'submission', private.owner_submission_item(saved_id), 'duplicates', public_duplicates);
end;
$$;

-- Self-only status list for the mobile app. No target-user argument and no
-- evidence, notes, reviewer snapshots or other claimants.
create function public.my_owner_submissions()
returns table (id uuid, kind text, status text, venue_id uuid, name text, city text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare caller_id uuid := auth.uid();
begin
  if caller_id is null or not exists (select 1 from public.profiles p where p.id = caller_id) then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  return query
    select x.id, x.kind, x.status, x.venue_id, x.name, x.city, x.created_at from (
      select c.id, 'claim'::text as kind, c.status::text as status, c.venue_id, v.name, v.city, c.created_at
        from private.venue_claims c join public.venues v on v.id = c.venue_id where c.claimant_user_id = caller_id
      union all
      select s.id, 'venue'::text, s.status::text, null::uuid, s.name, s.city, s.created_at
        from private.venue_submissions s where s.submitter_user_id = caller_id
    ) x order by x.created_at desc, x.id limit 50;
end;
$$;

revoke all on function private.require_owner_submitter(uuid), private.valid_owner_note(text),
  private.require_owner_evidence(uuid, text), private.require_owner_pending_capacity(uuid),
  private.validate_owner_venue_input(jsonb), private.owner_nearby_venues(double precision, double precision, text),
  private.owner_public_duplicates(double precision, double precision, text), private.owner_submission_item(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.owner_duplicate_candidates(uuid, double precision, double precision, text),
  public.owner_submit_claim(uuid, uuid, uuid, text, text),
  public.owner_submit_venue(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated;
grant execute on function public.owner_duplicate_candidates(uuid, double precision, double precision, text),
  public.owner_submit_claim(uuid, uuid, uuid, text, text),
  public.owner_submit_venue(uuid, uuid, jsonb, text, text, boolean) to service_role;
revoke all on function public.my_owner_submissions() from public, anon, authenticated;
grant execute on function public.my_owner_submissions() to authenticated;
notify pgrst, 'reload schema';
