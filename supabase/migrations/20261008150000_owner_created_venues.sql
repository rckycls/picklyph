-- Owners add their own venue: a new-venue submission now creates the owner's private
-- DRAFT listing straight away, instead of waiting for a reviewer to create one. The
-- proof photo and review stay. While the review is pending the creator may set the
-- draft up (details, courts, photos, hours, policies, calendar) but holds no
-- venue_owners link, so nothing that needs a verified owner (bookings, the owned
-- venues of my_account_access) changes. Approval (admin only) publishes the draft
-- and links the creator; merge or reject retires (suspends) it.

alter table private.venue_submissions
  -- The draft this submission created. Null only for T15 submissions decided before
  -- this migration; pending ones are backfilled below.
  add column venue_id uuid references public.venues(id) on delete set null;
create unique index venue_submissions_venue on private.venue_submissions (venue_id) where venue_id is not null;

alter table private.ownership_audit_events
  drop constraint ownership_audit_events_target_check,
  -- New venue submissions/rejections name the draft; T15/T17 rows have none.
  add constraint ownership_audit_events_target_check check
    (action in ('venue.submit', 'venue.reject') or target_venue_id is not null);

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
  'directory.create','directory.update','directory.publish','directory.unpublish','directory.suspend','directory.import',
  'owner.create','owner.update','owner.photo_add','owner.photo_remove','schedule.update','policy.update',
  'allocation.block','allocation.release','schedule.court_update'));

-- The owner's private draft: never public, claim under review, Court 1…N.
create function private.create_owner_draft(actor_id uuid, venue_name text, venue_address text, venue_city text,
  venue_province text, lat double precision, lng double precision, courts integer) returns uuid
language plpgsql set search_path = '' as $$
declare draft_id uuid;
begin
  insert into public.venues (name, address_line, city, province, latitude, longitude, publication_status, claim_status)
    values (venue_name, venue_address, venue_city, venue_province, lat, lng, 'draft', 'pending')
    returning id into draft_id;
  insert into public.courts (venue_id, name) select draft_id, 'Court ' || n from generate_series(1, courts) n;
  -- Same transaction: an audit failure aborts the draft.
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (actor_id, draft_id, 'owner.create');
  return draft_id;
end;
$$;

-- Pending T15 submissions get their draft now, so every pending submission has one.
do $$
declare pending record;
begin
  for pending in select * from private.venue_submissions s where s.status = 'pending' and s.venue_id is null
    order by s.created_at, s.id for update loop
    update private.venue_submissions s set venue_id = private.create_owner_draft(pending.submitter_user_id, pending.name,
      pending.address_line, pending.city, pending.province, pending.latitude, pending.longitude, pending.court_count)
      where s.id = pending.id;
  end loop;
end;
$$;
alter table private.venue_submissions
  add constraint venue_submissions_draft check (status <> 'pending' or venue_id is not null);

-- The creator of a draft whose review is pending. Callers that change the draft hold
-- its row lock first; review decisions take the same lock before changing status.
create function private.is_pending_venue_creator(actor_id uuid, target_venue_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select actor_id is not null and exists (select 1 from private.venue_submissions s join public.venues v on v.id = s.venue_id
    where s.submitter_user_id = actor_id and s.venue_id = target_venue_id and s.status = 'pending'
      and v.publication_status = 'draft');
$$;
-- Who may set a venue up: its verified owners (approved listing) and, until the
-- review decides, the creator of a draft. Bookings still need a verified owner.
create function private.is_venue_editor(actor_id uuid, target_venue_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_verified_venue_owner(actor_id, target_venue_id) or private.is_pending_venue_creator(actor_id, target_venue_id);
$$;
-- Linked owners and draft creators get "unavailable" when they can't edit; strangers get "not owner".
create function private.has_venue_relationship(actor_id uuid, target_venue_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select actor_id is not null and target_venue_id is not null and (
    exists (select 1 from private.venue_owners o where o.user_id = actor_id and o.venue_id = target_venue_id)
    or exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_id and s.venue_id = target_venue_id));
$$;

-- T18 lock order (listing, then owner link), now also admitting a pending creator.
create or replace function private.require_venue_owner(actor_id uuid, target_venue_id uuid) returns public.venues
language plpgsql set search_path = '' as $$
declare listing public.venues;
begin
  if not private.has_venue_relationship(actor_id, target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  end if;
  select v.* into listing from public.venues v where v.id = target_venue_id for update;
  perform 1 from private.venue_owners o where o.user_id = actor_id and o.venue_id = target_venue_id for share;
  if found then
    if listing.publication_status <> 'approved' or listing.claim_status <> 'verified' then
      raise exception 'Listing unavailable for editing' using errcode = 'P0002', hint = 'venue_unavailable';
    end if;
    return listing;
  end if;
  -- Read after the listing lock, so a review decision either finished first or waits.
  if not private.is_pending_venue_creator(actor_id, target_venue_id) then
    raise exception 'Listing unavailable for editing' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  return listing;
end;
$$;

-- Linked venues plus drafts under review, so the app can say why one isn't editable.
create or replace function public.owner_venue_list(actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_owner_submitter(actor_user_id);
  return coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'city', v.city,
      'province', v.province, 'publication_status', v.publication_status, 'claim_status', v.claim_status,
      'editable', private.is_venue_editor(actor_user_id, v.id),
      'active_court_count', (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active'),
      'photo_count', (select count(*) from public.venue_photos p where p.venue_id = v.id)) order by v.name, v.id)
    from (select v.* from public.venues v
      where v.id in (select o.venue_id from private.venue_owners o where o.user_id = actor_user_id)
        or v.id in (select s.venue_id from private.venue_submissions s where s.submitter_user_id = actor_user_id and s.status = 'pending')
      order by v.name, v.id limit 50) v), '[]'::jsonb);
end;
$$;

create or replace function public.owner_venue_read(actor_user_id uuid, target_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_venue_relationship(actor_user_id, target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  end if;
  if not private.is_venue_editor(actor_user_id, target_venue_id) then
    raise exception 'Listing unavailable for editing' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  return private.owner_venue_listing(target_venue_id);
end;
$$;

create or replace function public.owner_venue_policy_read(actor_user_id uuid, target_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_venue_relationship(actor_user_id, target_venue_id) then
    raise exception 'Owner required' using errcode='42501', hint='not_owner';
  end if;
  if not private.is_venue_editor(actor_user_id, target_venue_id) then
    raise exception 'Venue unavailable' using errcode='P0002', hint='venue_unavailable';
  end if;
  return private.venue_policy_view(target_venue_id);
end;
$$;

create or replace function public.court_allocation_read(actor_user_id uuid, target_venue_id uuid,
  range_start timestamptz, range_end timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if private.has_account_role(actor_user_id, 'admin') then
    if not exists (select 1 from public.venues v where v.id = target_venue_id and v.publication_status <> 'suspended') then
      raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
    end if;
  elsif not private.has_venue_relationship(actor_user_id, target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  elsif not private.is_venue_editor(actor_user_id, target_venue_id) then
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

create or replace function public.owner_calendar_read(actor_user_id uuid, target_venue_id uuid, start_date date, days integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz; range_start timestamptz; range_end timestamptz;
begin
  if private.has_account_role(actor_user_id, 'admin') then
    if not exists (select 1 from public.venues v where v.id = target_venue_id and v.publication_status <> 'suspended') then
      raise exception 'Venue unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
    end if;
  elsif not private.has_venue_relationship(actor_user_id, target_venue_id) then
    raise exception 'Venue-owner authorization required' using errcode = '42501', hint = 'not_owner';
  elsif not private.is_venue_editor(actor_user_id, target_venue_id) then
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

-- Self-only access read for the app. owned_venue_ids keeps its T08 meaning (approved,
-- verified links); pending_venue_ids are drafts the caller is setting up under review.
drop function public.my_account_access();
create function public.my_account_access()
returns table (privileged_roles public.privileged_role[], owned_venue_ids uuid[], pending_venue_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare caller_id uuid := auth.uid();
begin
  if caller_id is null or not exists (select 1 from public.profiles p where p.id = caller_id) then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  return query select
    array(select r.role from private.account_roles r where r.user_id = caller_id order by r.role),
    array(select o.venue_id from private.venue_owners o
      where o.user_id = caller_id and private.is_verified_venue_owner(caller_id, o.venue_id)
      order by o.venue_id),
    array(select s.venue_id from private.venue_submissions s
      where s.submitter_user_id = caller_id and private.is_pending_venue_creator(caller_id, s.venue_id)
      order by s.venue_id);
end;
$$;

-- T15 command, same contract: the submission now also creates the owner's draft.
create or replace function public.owner_submit_venue(actor_user_id uuid, submission_request_id uuid, venue_input jsonb,
  evidence_ref text, submission_note text, acknowledge_duplicates boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  existing_id uuid; saved_id uuid; draft_id uuid; lat double precision; lng double precision; venue_name text;
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
  -- Reviewer snapshot before the draft exists, so it never lists itself.
  select coalesce(array_agg(n.id order by n.id), '{}') into nearby_ids from private.owner_nearby_venues(lat, lng, venue_name) n;
  select coalesce(array_agg(s.id order by s.id), '{}') into nearby_pending from private.venue_submissions s
    where s.status = 'pending' and s.submitter_user_id <> actor_user_id
      and extensions.st_dwithin(s.location::extensions.geography,
        extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography, 150);
  draft_id := private.create_owner_draft(actor_user_id, venue_name, venue_input ->> 'address_line', venue_input ->> 'city',
    venue_input ->> 'province', lat, lng, (venue_input ->> 'court_count')::integer);
  insert into private.venue_submissions (submitter_user_id, request_id, name, address_line, city, province,
    latitude, longitude, court_count, evidence_path, note, duplicates_acknowledged, nearby_venue_ids, nearby_submission_ids, venue_id)
  values (actor_user_id, submission_request_id, venue_name, venue_input ->> 'address_line', venue_input ->> 'city',
    venue_input ->> 'province', lat, lng, (venue_input ->> 'court_count')::integer, evidence_ref, submission_note,
    acknowledge_duplicates, nearby_ids, nearby_pending, draft_id)
  returning id into saved_id;
  insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
    values (actor_user_id, 'venue.submit', saved_id, draft_id);
  return jsonb_build_object('outcome', 'created', 'submission', private.owner_submission_item(saved_id), 'duplicates', public_duplicates);
end;
$$;

-- Submitters see their draft (and its current name) while it's under review, the
-- listing an approval resolved to, and no listing after a rejection.
create or replace function private.owner_submission_item(subject_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('id', c.id, 'kind', 'claim', 'status', c.status, 'venue_id', c.venue_id,
       'name', v.name, 'city', v.city, 'created_at', c.created_at)
     from private.venue_claims c join public.venues v on v.id = c.venue_id where c.id = subject_id),
    (select jsonb_build_object('id', s.id, 'kind', 'venue', 'status', s.status,
       'venue_id', case s.status when 'pending' then s.venue_id when 'approved' then s.resolved_venue_id end,
       'name', case when s.status = 'pending' then coalesce(v.name, s.name) else s.name end,
       'city', case when s.status = 'pending' then coalesce(v.city, s.city) else s.city end, 'created_at', s.created_at)
     from private.venue_submissions s left join public.venues v on v.id = s.venue_id where s.id = subject_id));
$$;

create or replace function public.my_owner_submissions()
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
      select s.id, 'venue'::text, s.status::text,
        case s.status when 'pending' then s.venue_id when 'approved' then s.resolved_venue_id end,
        case when s.status = 'pending' then coalesce(v.name, s.name) else s.name end,
        case when s.status = 'pending' then coalesce(v.city, s.city) else s.city end, s.created_at
        from private.venue_submissions s left join public.venues v on v.id = s.venue_id where s.submitter_user_id = caller_id
    ) x order by x.created_at desc, x.id limit 50;
end;
$$;

-- Reviewer detail: the draft as the owner has set it up now, beside what they first
-- submitted. Nearby lists never include the submission's own draft.
create or replace function private.ownership_review_item(subject_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('id', c.id, 'kind', 'claim', 'status', c.status, 'created_at', c.created_at,
       'note', c.note, 'submitter', private.ownership_submitter(c.claimant_user_id),
       'review', case when c.reviewed_at is null then null else jsonb_build_object('reviewed_by', c.reviewed_by,
         'reviewed_at', c.reviewed_at, 'reason', c.review_reason, 'resolution', null, 'resolved_venue_id', null) end,
       'venue', jsonb_build_object('id', v.id, 'name', v.name, 'address_line', v.address_line, 'city', v.city,
         'province', v.province, 'latitude', v.latitude, 'longitude', v.longitude,
         'publication_status', v.publication_status, 'claim_status', v.claim_status,
         'owner_count', (select count(*) from private.venue_owners o where o.venue_id = v.id)),
       'other_pending_claims', (select count(*) from private.venue_claims o
         where o.venue_id = c.venue_id and o.id <> c.id and o.status = 'pending'))
     from private.venue_claims c join public.venues v on v.id = c.venue_id where c.id = subject_id),
    (select jsonb_build_object('id', s.id, 'kind', 'venue', 'status', s.status, 'created_at', s.created_at,
       'note', s.note, 'submitter', private.ownership_submitter(s.submitter_user_id),
       'review', case when s.reviewed_at is null then null else jsonb_build_object('reviewed_by', s.reviewed_by,
         'reviewed_at', s.reviewed_at, 'reason', s.review_reason, 'resolution', s.resolution,
         'resolved_venue_id', s.resolved_venue_id) end,
       'proposed', jsonb_build_object('name', s.name, 'address_line', s.address_line, 'city', s.city,
         'province', s.province, 'latitude', s.latitude, 'longitude', s.longitude, 'court_count', s.court_count),
       'draft', (select jsonb_build_object('id', d.id, 'name', d.name, 'address_line', d.address_line, 'city', d.city,
           'province', d.province, 'latitude', d.latitude, 'longitude', d.longitude,
           'publication_status', d.publication_status, 'claim_status', d.claim_status,
           'active_court_count', (select count(*) from public.courts c where c.venue_id = d.id and c.status = 'active'),
           'photo_count', (select count(*) from public.venue_photos p where p.venue_id = d.id))
         from public.venues d where d.id = s.venue_id),
       'duplicates_acknowledged', s.duplicates_acknowledged,
       -- Submission-time snapshot plus a fresh check, including drafts/suspended
       -- listings that submitters were never shown.
       'nearby_venues', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name,
           'address_line', n.address_line, 'city', n.city, 'province', n.province,
           'publication_status', n.publication_status, 'claim_status', n.claim_status,
           'distance_m', n.distance_m, 'in_snapshot', n.in_snapshot) order by n.distance_m, n.id), '[]'::jsonb)
         from (select v.id, v.name, v.address_line, v.city, v.province, v.publication_status, v.claim_status,
             round(extensions.st_distance(v.location::extensions.geography, s.location::extensions.geography))::integer as distance_m,
             v.id = any(s.nearby_venue_ids) as in_snapshot
           from public.venues v
           where v.id is distinct from s.venue_id and (v.id = any(s.nearby_venue_ids)
             or v.id in (select x.id from private.owner_nearby_venues(s.latitude, s.longitude, s.name) x)
             or (v.publication_status = 'suspended' and extensions.st_dwithin(v.location::extensions.geography,
               s.location::extensions.geography, 150)))
           order by 8, 1 limit 20) n),
       'nearby_submissions', (select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'name', n.name,
           'status', n.status, 'distance_m', n.distance_m, 'same_submitter', n.same_submitter,
           'in_snapshot', n.in_snapshot) order by n.distance_m, n.id), '[]'::jsonb)
         from (select o.id, o.name, o.status,
             round(extensions.st_distance(o.location::extensions.geography, s.location::extensions.geography))::integer as distance_m,
             o.submitter_user_id = s.submitter_user_id as same_submitter, o.id = any(s.nearby_submission_ids) as in_snapshot
           from private.venue_submissions o
           where o.id <> s.id and (o.id = any(s.nearby_submission_ids)
             or (o.status = 'pending' and extensions.st_dwithin(o.location::extensions.geography,
               s.location::extensions.geography, 150)))
           order by 4, 1 limit 20) n))
     from private.venue_submissions s where s.id = subject_id));
$$;

-- Queue rows name a pending venue by its draft's current name.
create or replace function public.ownership_review_queue(actor_user_id uuid, after_created_at timestamptz default null,
  after_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare rows jsonb;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  if (after_created_at is null) <> (after_id is null) then
    raise exception 'Invalid queue cursor' using errcode = '22023', hint = 'invalid_input';
  end if;
  with pending as (
    select c.id, 'claim'::text as kind, c.created_at, v.name, v.city, v.province, c.venue_id,
      (select count(*) from private.venue_claims o where o.venue_id = c.venue_id and o.id <> c.id and o.status = 'pending')
        + (select count(*) from private.venue_owners o where o.venue_id = c.venue_id) as signals
    from private.venue_claims c join public.venues v on v.id = c.venue_id where c.status = 'pending'
    union all
    select s.id, 'venue', s.created_at, coalesce(d.name, s.name), coalesce(d.city, s.city), coalesce(d.province, s.province), s.venue_id,
      cardinality(s.nearby_venue_ids) + cardinality(s.nearby_submission_ids)
    from private.venue_submissions s left join public.venues d on d.id = s.venue_id where s.status = 'pending'
  ), page as (
    select p.* from pending p
    where after_id is null or (p.created_at, p.id) > (after_created_at, after_id)
    order by p.created_at, p.id limit 51
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'created_at', p.created_at,
    'name', p.name, 'city', p.city, 'province', p.province, 'venue_id', p.venue_id, 'duplicate_signals', p.signals)
    order by p.created_at, p.id), '[]'::jsonb) into rows from page p;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(rows) with ordinality x(e, n) where n <= 50), '[]'::jsonb),
    'next_cursor', case when jsonb_array_length(rows) > 50 then jsonb_build_object(
      'created_at', rows -> 49 -> 'created_at', 'id', rows -> 49 -> 'id') else null end,
    'pending_total', (select count(*) from private.venue_claims c where c.status = 'pending')
      + (select count(*) from private.venue_submissions s where s.status = 'pending'));
end;
$$;

-- Claims: approve|reject (unchanged). New venues: approve (admin only: publishes the
-- owner's draft and links them), merge into an existing listing, or reject; merge and
-- reject retire the draft. Repeating the recorded decision returns outcome 'existing'.
create or replace function public.ownership_review_decide(actor_user_id uuid, subject_id uuid, decision text,
  target_venue_id uuid, rejection_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  claim private.venue_claims%rowtype; submission private.venue_submissions%rowtype;
  listing public.venue_publication_status; draft public.venues; draft_id uuid; owner_id uuid;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  if subject_id is null or decision is null or decision not in ('approve', 'reject', 'merge')
    or (decision = 'reject') <> (rejection_reason is not null)
    or rejection_reason not in ('insufficient_evidence', 'not_owner', 'duplicate', 'not_a_venue', 'other')
    or (decision = 'merge') <> (target_venue_id is not null) then
    raise exception 'Invalid review decision' using errcode = '22023', hint = 'invalid_input';
  end if;

  select c.* into claim from private.venue_claims c where c.id = subject_id for update;
  if found then
    if decision not in ('approve', 'reject') then
      raise exception 'Invalid claim decision' using errcode = '22023', hint = 'invalid_input';
    end if;
    if claim.claimant_user_id = actor_user_id then
      raise exception 'Reviewers cannot decide their own submissions' using errcode = '42501', hint = 'self_review';
    end if;
    if claim.status <> 'pending' then
      if (claim.status = 'approved' and decision = 'approve')
        or (claim.status = 'rejected' and decision = 'reject' and claim.review_reason = rejection_reason) then
        return jsonb_build_object('outcome', 'existing', 'item', private.ownership_review_item(subject_id));
      end if;
      raise exception 'Already decided' using errcode = '23505', hint = 'already_decided';
    end if;
    if decision = 'approve' then
      select v.publication_status into listing from public.venues v where v.id = claim.venue_id for update;
      if listing = 'suspended' then
        raise exception 'Listing is suspended' using errcode = 'P0002', hint = 'listing_unavailable';
      end if;
      perform 1 from public.profiles p where p.id = claim.claimant_user_id for share;
      if not found then raise exception 'Submitter account not found' using errcode = 'P0002', hint = 'not_found'; end if;
      update private.venue_claims c set status = 'approved', reviewed_by = actor_user_id, reviewed_at = now()
        where c.id = subject_id;
      update public.venues v set claim_status = 'verified' where v.id = claim.venue_id and v.claim_status <> 'verified';
      insert into private.venue_owners (venue_id, user_id, verified_by)
        values (claim.venue_id, claim.claimant_user_id, actor_user_id) on conflict (venue_id, user_id) do nothing;
    else
      update private.venue_claims c set status = 'rejected', reviewed_by = actor_user_id, reviewed_at = now(),
        review_reason = rejection_reason where c.id = subject_id;
    end if;
    -- Same transaction: an audit failure aborts the decision.
    insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
      values (actor_user_id, case decision when 'approve' then 'claim.approve' else 'claim.reject' end, subject_id, claim.venue_id);
    return jsonb_build_object('outcome', 'decided', 'item', private.ownership_review_item(subject_id));
  end if;

  -- Lock the owner's draft before the submission, the order owner edits use
  -- (listing first), so a decision and an edit serialize instead of deadlocking.
  select s.venue_id into draft_id from private.venue_submissions s where s.id = subject_id;
  if not found then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  select v.* into draft from public.venues v where v.id = draft_id for update;
  select s.* into submission from private.venue_submissions s where s.id = subject_id for update;
  if submission.submitter_user_id = actor_user_id then
    raise exception 'Reviewers cannot decide their own submissions' using errcode = '42501', hint = 'self_review';
  end if;
  if submission.status <> 'pending' then
    if (submission.status = 'approved' and decision = 'approve' and submission.resolution = 'new')
      or (submission.status = 'approved' and decision = 'merge' and submission.resolution = 'merge'
        and submission.resolved_venue_id = target_venue_id)
      or (submission.status = 'rejected' and decision = 'reject' and submission.review_reason = rejection_reason) then
      return jsonb_build_object('outcome', 'existing', 'item', private.ownership_review_item(subject_id));
    end if;
    raise exception 'Already decided' using errcode = '23505', hint = 'already_decided';
  end if;
  if draft.id is null or draft.publication_status = 'suspended' then
    raise exception 'Draft listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
  end if;

  if decision = 'approve' then
    -- Publishing a listing is directory curation: administrators only.
    perform 1 from private.account_roles r where r.user_id = actor_user_id and r.role = 'admin' for share;
    if not found then
      raise exception 'Administrator authorization required' using errcode = '42501', hint = 'admin_required';
    end if;
    if not exists (select 1 from public.courts c where c.venue_id = draft.id and c.status = 'active') then
      raise exception 'Add an active court before publishing' using errcode = '22023', hint = 'active_court_required';
    end if;
  elsif decision = 'merge' then
    if target_venue_id = draft.id then
      raise exception 'Approve the draft instead of merging it into itself' using errcode = '22023', hint = 'invalid_input';
    end if;
    select v.publication_status into listing from public.venues v where v.id = target_venue_id for update;
    if not found or listing = 'suspended' then
      raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
    end if;
  end if;

  if decision = 'reject' then
    update private.venue_submissions s set status = 'rejected', reviewed_by = actor_user_id, reviewed_at = now(),
      review_reason = rejection_reason where s.id = subject_id;
  else
    owner_id := submission.submitter_user_id;
    perform 1 from public.profiles p where p.id = owner_id for share;
    if not found then raise exception 'Submitter account not found' using errcode = 'P0002', hint = 'not_found'; end if;
    if decision = 'approve' then
      update public.venues v set publication_status = 'approved', claim_status = 'verified' where v.id = draft.id;
      if draft.publication_status = 'draft' then
        insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
          values (actor_user_id, draft.id, 'directory.publish');
      end if;
    else
      update public.venues v set claim_status = 'verified' where v.id = target_venue_id and v.claim_status <> 'verified';
    end if;
    insert into private.venue_owners (venue_id, user_id, verified_by)
      values (case decision when 'approve' then draft.id else target_venue_id end, owner_id, actor_user_id)
      on conflict (venue_id, user_id) do nothing;
    update private.venue_submissions s set status = 'approved', reviewed_by = actor_user_id, reviewed_at = now(),
      resolution = case decision when 'approve' then 'new' else 'merge' end,
      resolved_venue_id = case decision when 'approve' then draft.id else target_venue_id end
      where s.id = subject_id;
  end if;
  if decision <> 'approve' then
    -- Retire the draft: it never publishes, and the creator can no longer edit it. If an
    -- admin already published it from the directory, it stays listed but unclaimed.
    update public.venues v set
      publication_status = case when v.publication_status = 'draft' then 'suspended' else v.publication_status end,
      claim_status = case when v.claim_status = 'pending' then 'unclaimed' else v.claim_status end
      where v.id = draft.id;
    if draft.publication_status = 'draft' then
      insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
        values (actor_user_id, draft.id, 'directory.suspend');
    end if;
  end if;
  insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
    values (actor_user_id, case decision when 'approve' then 'venue.approve' when 'merge' then 'venue.merge' else 'venue.reject' end,
      subject_id, case decision when 'merge' then target_venue_id else draft.id end);
  return jsonb_build_object('outcome', 'decided', 'item', private.ownership_review_item(subject_id));
end;
$$;

revoke all on function private.create_owner_draft(uuid, text, text, text, text, double precision, double precision, integer),
  private.is_pending_venue_creator(uuid, uuid), private.is_venue_editor(uuid, uuid), private.has_venue_relationship(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.my_account_access() from public, anon, authenticated;
grant execute on function public.my_account_access() to authenticated;
notify pgrst, 'reload schema';
