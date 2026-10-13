-- T54: a court owner redeems the pre-launch claim code (T53) in the app. The registration's private draft
-- becomes the claimant's own new-venue submission (T15/owner-created drafts), so they set it up while T17
-- review approves (publishes and links them), merges or rejects it. Nothing here publishes or links an owner.
-- The code reaches the database only as the T53 HMAC; wrong tries count toward a per-account lockout.

alter table private.venue_registrations
  -- The account that redeemed the code: a bare UUID (no FK), like audit actors, so it outlives the account.
  add column claimed_by uuid,
  add column claimed_at timestamptz,
  -- The venue_submissions row the registration became (no FK: that row goes with its Auth user).
  add column submission_id uuid,
  -- The claiming account's email equalled the registration email when the code was redeemed (a reviewer signal).
  add column claim_email_matched boolean,
  drop constraint venue_registrations_status_check,
  add constraint venue_registrations_status_check check (status in ('open', 'claimed', 'erased')),
  add constraint venue_registrations_claim_fields check ((claimed_at is null) = (claimed_by is null)
    and (claimed_at is null) = (submission_id is null) and (claimed_at is null) = (claim_email_matched is null)),
  add constraint venue_registrations_unclaimed check (status <> 'open' or claimed_at is null),
  add constraint venue_registrations_claimed check (status <> 'claimed'
    or (owner_name is not null and email is not null and code_hash is null and erased_at is null and claimed_at is not null));
create unique index venue_registrations_submission on private.venue_registrations (submission_id) where submission_id is not null;
create index venue_registrations_claimed_retention on private.venue_registrations (claimed_at, id) where status = 'claimed';

alter table private.ownership_audit_events drop constraint ownership_audit_events_action_check,
  add constraint ownership_audit_events_action_check check (action in ('claim.submit', 'venue.submit',
    'claim.approve', 'claim.reject', 'venue.approve', 'venue.merge', 'venue.reject', 'registration.claim'));

-- Wrong claim codes per account: 5 within an hour lock the account out of codes for an hour.
create table private.claim_code_failures (
  user_id uuid primary key references auth.users(id) on delete cascade,
  failures integer not null check (failures between 1 and 1000),
  window_started_at timestamptz not null,
  locked_until timestamptz
);
alter table private.claim_code_failures enable row level security;
revoke all on private.claim_code_failures from public, anon, authenticated, service_role;

-- Seconds until the account may try codes again, or null when it may try now.
create function private.claim_code_lock_seconds(actor_id uuid, at_time timestamptz) returns integer
language plpgsql set search_path = '' as $$
declare until timestamptz;
begin
  select f.locked_until into until from private.claim_code_failures f where f.user_id = actor_id for update;
  if until is not null and until > at_time then
    return greatest(1, ceil(extract(epoch from until - at_time))::integer);
  end if;
  return null;
end;
$$;

-- Counts one wrong try (callers return an answer instead of raising, so this commits). Returns the lock
-- seconds when this try locked the account, else null.
create function private.claim_code_fail(actor_id uuid, at_time timestamptz) returns integer
language plpgsql set search_path = '' as $$
declare item private.claim_code_failures;
begin
  select f.* into item from private.claim_code_failures f where f.user_id = actor_id for update;
  if not found or item.window_started_at <= at_time - interval '60 minutes'
    or (item.locked_until is not null and item.locked_until <= at_time) then
    insert into private.claim_code_failures as f (user_id, failures, window_started_at, locked_until)
      values (actor_id, 1, at_time, null)
      on conflict (user_id) do update set failures = 1, window_started_at = at_time, locked_until = null;
    return null;
  end if;
  update private.claim_code_failures f set failures = f.failures + 1,
    locked_until = case when f.failures + 1 >= 5 then at_time + interval '60 minutes' end
    where f.user_id = actor_id returning f.* into item;
  return case when item.locked_until is null then null else ceil(extract(epoch from item.locked_until - at_time))::integer end;
end;
$$;

create function private.claim_code_refusal(locked integer) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('outcome', case when locked is null then 'invalid' else 'locked' end,
    'retry_after_seconds', locked);
$$;

-- The venue a code names, so the owner can confirm it before adding proof. Wrong, used and erased codes
-- are all `invalid` and count toward the lockout; a locked account gets `locked` even for a right code.
create function public.owner_registration_check(actor_user_id uuid, code_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz; locked integer; listing public.venues;
begin
  perform private.require_owner_submitter(actor_user_id);
  if code_hash is null or code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid code check' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- The actor's owner commands and code tries serialize, so the lockout count cannot race.
  perform pg_advisory_xact_lock(hashtextextended('pickly:owner-submit:' || actor_user_id::text, 0));
  at_time := clock_timestamp();
  locked := private.claim_code_lock_seconds(actor_user_id, at_time);
  if locked is not null then
    return private.claim_code_refusal(locked) || jsonb_build_object('registration', null);
  end if;
  select v.* into listing from private.venue_registrations r join public.venues v on v.id = r.venue_id
    where r.code_hash = owner_registration_check.code_hash and r.status = 'open';
  if not found then
    return private.claim_code_refusal(private.claim_code_fail(actor_user_id, at_time)) || jsonb_build_object('registration', null);
  end if;
  if listing.publication_status = 'suspended' then
    raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
  end if;
  return jsonb_build_object('outcome', 'valid', 'retry_after_seconds', null, 'registration', jsonb_build_object(
    'name', listing.name, 'address_line', listing.address_line, 'city', listing.city, 'province', listing.province,
    'court_count', (select count(*) from public.courts c where c.venue_id = listing.id and c.status = 'active')));
end;
$$;

-- Redeems a code: the registration's draft becomes the actor's pending new-venue submission (the T15
-- evidence and caps apply). A retry with the same request ID returns the original although the code is spent.
create function public.owner_redeem_registration(actor_user_id uuid, submission_request_id uuid, code_hash text,
  evidence_ref text, submission_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  at_time timestamptz; locked integer; existing_id uuid; target_id uuid; listing public.venues;
  registration private.venue_registrations; saved_id uuid; court_total integer; nearby_ids uuid[]; nearby_pending uuid[];
  account_email text;
begin
  perform private.require_owner_submitter(actor_user_id);
  if submission_request_id is null or code_hash is null or code_hash !~ '^[0-9a-f]{64}$'
    or not private.valid_owner_note(submission_note) then
    raise exception 'Invalid submission' using errcode = '22023', hint = 'invalid_input';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pickly:owner-submit:' || actor_user_id::text, 0));
  select s.id into existing_id from private.venue_submissions s
    where s.submitter_user_id = actor_user_id and s.request_id = submission_request_id;
  if found then
    if exists (select 1 from private.venue_registrations r where r.submission_id = existing_id) then
      return jsonb_build_object('outcome', 'existing', 'submission', private.owner_submission_item(existing_id),
        'duplicates', '[]'::jsonb, 'retry_after_seconds', null);
    end if;
    raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end if;
  if exists (select 1 from private.venue_claims c where c.claimant_user_id = actor_user_id and c.request_id = submission_request_id) then
    raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end if;
  at_time := clock_timestamp();
  locked := private.claim_code_lock_seconds(actor_user_id, at_time);
  if locked is not null then
    return private.claim_code_refusal(locked) || jsonb_build_object('submission', null, 'duplicates', '[]'::jsonb);
  end if;

  -- Listing first, then the registration: the order of the privacy sweep and of owner edits.
  select r.venue_id into target_id from private.venue_registrations r
    where r.code_hash = owner_redeem_registration.code_hash and r.status = 'open';
  if found then
    select v.* into listing from public.venues v where v.id = target_id for update;
    select r.* into registration from private.venue_registrations r
      where r.venue_id = target_id and r.code_hash = owner_redeem_registration.code_hash and r.status = 'open' for update;
  end if;
  if registration.id is null then
    return private.claim_code_refusal(private.claim_code_fail(actor_user_id, at_time))
      || jsonb_build_object('submission', null, 'duplicates', '[]'::jsonb);
  end if;
  if listing.publication_status = 'suspended' then
    raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
  end if;
  if listing.claim_status = 'verified' then
    raise exception 'Listing already has a verified owner' using errcode = '23505', hint = 'already_verified';
  end if;
  if exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_user_id and s.status = 'pending'
    and extensions.st_dwithin(s.location::extensions.geography, listing.location::extensions.geography, 150)) then
    raise exception 'A submission for this place is already awaiting review' using errcode = '23505', hint = 'already_pending';
  end if;
  perform private.require_owner_pending_capacity(actor_user_id);
  perform private.require_owner_evidence(actor_user_id, evidence_ref);

  -- Reviewer snapshot: what the registration saw plus a fresh check, never the draft itself.
  select coalesce(array_agg(x.id order by x.id), '{}') into nearby_ids from (
    select unnest(registration.nearby_venue_ids) as id
    union select n.id from private.owner_nearby_venues(listing.latitude, listing.longitude, listing.name) n) x
    where x.id <> listing.id;
  select coalesce(array_agg(s.id order by s.id), '{}') into nearby_pending from private.venue_submissions s
    where s.status = 'pending' and s.submitter_user_id <> actor_user_id
      and extensions.st_dwithin(s.location::extensions.geography, listing.location::extensions.geography, 150);
  select count(*) into court_total from public.courts c where c.venue_id = listing.id and c.status = 'active';
  insert into private.venue_submissions (submitter_user_id, request_id, name, address_line, city, province,
    latitude, longitude, court_count, evidence_path, note, duplicates_acknowledged, nearby_venue_ids, nearby_submission_ids, venue_id)
  values (actor_user_id, submission_request_id, listing.name, listing.address_line, listing.city, listing.province,
    listing.latitude, listing.longitude, greatest(1, least(40, court_total)), evidence_ref, submission_note,
    registration.duplicates_acknowledged, nearby_ids, nearby_pending, listing.id)
  returning id into saved_id;
  update public.venues v set claim_status = 'pending' where v.id = listing.id and v.claim_status = 'unclaimed';
  select lower(u.email) into account_email from auth.users u where u.id = actor_user_id;
  update private.venue_registrations r set status = 'claimed', code_hash = null, claimed_by = actor_user_id,
    claimed_at = at_time, submission_id = saved_id, claim_email_matched = coalesce(account_email = r.email, false)
    where r.id = registration.id;
  delete from private.claim_code_failures f where f.user_id = actor_user_id;
  -- Same transaction: an audit failure aborts the redemption.
  insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
    values (actor_user_id, 'registration.claim', saved_id, listing.id);
  return jsonb_build_object('outcome', 'created', 'submission', private.owner_submission_item(saved_id),
    'duplicates', '[]'::jsonb, 'retry_after_seconds', null);
end;
$$;

-- What every reviewer sees about a redeemed registration; contact details are added for admins only.
create function private.registration_review(subject_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('registered_at', r.created_at, 'claimed_at', r.claimed_at, 'role', r.role,
    'email_matched', r.claim_email_matched, 'erased', r.status = 'erased', 'contact', null)
  from private.venue_registrations r where r.submission_id = subject_id;
$$;

-- Owner-created-venues reviewer detail, plus the redeemed registration (T54).
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
           order by 4, 1 limit 20) n),
       'registration', private.registration_review(s.id))
     from private.venue_submissions s where s.id = subject_id));
$$;

-- T51b read, plus the registrant's contact details for admins (never moderators) until the sweep erases them.
create or replace function public.ownership_review_read(actor_user_id uuid, subject_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb; contact jsonb;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  item := private.ownership_review_item(subject_id);
  if item is null then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  item := item || jsonb_build_object('evidence_removed_at', coalesce(
    (select c.evidence_purged_at from private.venue_claims c where c.id = subject_id),
    (select s.evidence_purged_at from private.venue_submissions s where s.id = subject_id)));
  if jsonb_typeof(item -> 'registration') = 'object' and private.has_account_role(actor_user_id, 'admin') then
    select jsonb_build_object('owner_name', r.owner_name, 'email', r.email, 'phone', r.phone, 'note', r.note) into contact
      from private.venue_registrations r where r.submission_id = subject_id and r.status = 'claimed';
    if contact is not null then item := jsonb_set(item, '{registration,contact}', contact); end if;
  end if;
  return item;
end;
$$;

-- Owner-created-venues queue, plus a pre-launch marker (T54).
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
        + (select count(*) from private.venue_owners o where o.venue_id = c.venue_id) as signals, false as prelaunch
    from private.venue_claims c join public.venues v on v.id = c.venue_id where c.status = 'pending'
    union all
    select s.id, 'venue', s.created_at, coalesce(d.name, s.name), coalesce(d.city, s.city), coalesce(d.province, s.province), s.venue_id,
      cardinality(s.nearby_venue_ids) + cardinality(s.nearby_submission_ids),
      exists (select 1 from private.venue_registrations r where r.submission_id = s.id)
    from private.venue_submissions s left join public.venues d on d.id = s.venue_id where s.status = 'pending'
  ), page as (
    select p.* from pending p
    where after_id is null or (p.created_at, p.id) > (after_created_at, after_id)
    order by p.created_at, p.id limit 51
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'created_at', p.created_at,
    'name', p.name, 'city', p.city, 'province', p.province, 'venue_id', p.venue_id, 'duplicate_signals', p.signals,
    'prelaunch', p.prelaunch) order by p.created_at, p.id), '[]'::jsonb) into rows from page p;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(rows) with ordinality x(e, n) where n <= 50), '[]'::jsonb),
    'next_cursor', case when jsonb_array_length(rows) > 50 then jsonb_build_object(
      'created_at', rows -> 49 -> 'created_at', 'id', rows -> 49 -> 'id') else null end,
    'pending_total', (select count(*) from private.venue_claims c where c.status = 'pending')
      + (select count(*) from private.venue_submissions s where s.status = 'pending'));
end;
$$;

-- T53 sweep, plus: a claimed registration's contact details are erased 30 days after its claim's review
-- decision, or once the submission is gone (the claimant deleted their account). The review decides the draft.
create or replace function private.privacy_retention_sweep(batch_limit integer default 500) returns jsonb
language plpgsql set search_path = '' as $$
declare cleared integer; erased integer := 0; claimed integer := 0; item record;
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
  for item in select r.id, r.venue_id from private.venue_registrations r
    where r.status = 'claimed' and not exists (select 1 from private.venue_submissions s where s.id = r.submission_id
      and (s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days'))
    order by r.claimed_at, r.id limit batch_limit loop
    perform 1 from public.venues v where v.id = item.venue_id for update;
    perform 1 from private.venue_registrations r where r.id = item.id and r.status = 'claimed'
      and not exists (select 1 from private.venue_submissions s where s.id = r.submission_id
        and (s.reviewed_at is null or s.reviewed_at >= clock_timestamp() - interval '30 days')) for update;
    continue when not found;
    update private.venue_registrations r set status = 'erased', owner_name = null, email = null, phone = null,
      note = null, erased_at = clock_timestamp() where r.id = item.id;
    claimed := claimed + 1;
  end loop;
  return jsonb_build_object('report_details', cleared, 'prelaunch_registrations', erased + claimed,
    'more', cleared = batch_limit or erased = batch_limit or claimed = batch_limit);
end;
$$;

revoke all on function private.claim_code_lock_seconds(uuid, timestamptz), private.claim_code_fail(uuid, timestamptz),
  private.claim_code_refusal(integer), private.registration_review(uuid), private.ownership_review_item(uuid),
  private.privacy_retention_sweep(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.owner_registration_check(uuid, text), public.owner_redeem_registration(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.owner_registration_check(uuid, text), public.owner_redeem_registration(uuid, uuid, text, text, text)
  to service_role;
notify pgrst, 'reload schema';
