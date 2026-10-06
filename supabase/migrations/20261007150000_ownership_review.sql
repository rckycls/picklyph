-- T17: ownership review for T15 claims and missing-venue submissions.
-- Current admins/moderators decide; approval verifies ownership in the same
-- audited transaction. Nothing here publishes a listing, grants a role or
-- exposes evidence/reviewer snapshots to client roles. Retention is T47.

alter table private.venue_claims
  add column reviewed_by uuid references auth.users(id) on delete set null,
  add column reviewed_at timestamptz,
  add column review_reason text check (review_reason in
    ('insufficient_evidence', 'not_owner', 'duplicate', 'not_a_venue', 'other')),
  add constraint venue_claims_reviewed check ((status = 'pending') = (reviewed_at is null)),
  add constraint venue_claims_rejection check ((status = 'rejected') = (review_reason is not null));
create index venue_claims_queue on private.venue_claims (created_at, id) where status = 'pending';

alter table private.venue_submissions
  add column reviewed_by uuid references auth.users(id) on delete set null,
  add column reviewed_at timestamptz,
  add column review_reason text check (review_reason in
    ('insufficient_evidence', 'not_owner', 'duplicate', 'not_a_venue', 'other')),
  -- 'new' created a draft listing; 'merge' resolved it as an existing listing.
  add column resolution text check (resolution in ('new', 'merge')),
  add column resolved_venue_id uuid references public.venues(id) on delete set null,
  add constraint venue_submissions_reviewed check ((status = 'pending') = (reviewed_at is null)),
  add constraint venue_submissions_rejection check ((status = 'rejected') = (review_reason is not null)),
  add constraint venue_submissions_resolution check ((status = 'approved') = (resolution is not null));
create index venue_submissions_queue on private.venue_submissions (created_at, id) where status = 'pending';

alter table private.ownership_audit_events
  drop constraint ownership_audit_events_action_check,
  drop constraint ownership_audit_events_check,
  add constraint ownership_audit_events_action_check check (action in ('claim.submit', 'venue.submit',
    'claim.approve', 'claim.reject', 'venue.approve', 'venue.merge', 'venue.reject')),
  add constraint ownership_audit_events_target_check check ((action in ('venue.submit', 'venue.reject')) = (target_venue_id is null));

-- Hold the assignment until commit, so revocation cannot race a decision.
create function private.require_ownership_reviewer(actor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from private.account_roles r where r.user_id = actor_id and r.role in ('admin', 'moderator') for share;
  if not found then
    raise exception 'Ownership-review authorization required' using errcode = '42501', hint = 'reviewer_required';
  end if;
end;
$$;

create function private.ownership_submitter(user_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'display_name', p.display_name, 'joined_at', p.created_at,
    'pending', (select count(*) from private.venue_claims c where c.claimant_user_id = p.id and c.status = 'pending')
      + (select count(*) from private.venue_submissions s where s.submitter_user_id = p.id and s.status = 'pending'),
    'approved', (select count(*) from private.venue_claims c where c.claimant_user_id = p.id and c.status = 'approved')
      + (select count(*) from private.venue_submissions s where s.submitter_user_id = p.id and s.status = 'approved'),
    'rejected', (select count(*) from private.venue_claims c where c.claimant_user_id = p.id and c.status = 'rejected')
      + (select count(*) from private.venue_submissions s where s.submitter_user_id = p.id and s.status = 'rejected'))
  from public.profiles p where p.id = user_id;
$$;

-- Reviewer-only detail. Evidence paths never leave the database through this
-- shape; the console streams the bytes through its own verified route.
create function private.ownership_review_item(subject_id uuid) returns jsonb
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
           where v.id = any(s.nearby_venue_ids)
             or v.id in (select x.id from private.owner_nearby_venues(s.latitude, s.longitude, s.name) x)
             or (v.publication_status = 'suspended' and extensions.st_dwithin(v.location::extensions.geography,
               s.location::extensions.geography, 150))
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

-- Pending queue, oldest first, keyset by (created_at, id). actor_user_id MUST
-- come from a server-verified token.
create function public.ownership_review_queue(actor_user_id uuid, after_created_at timestamptz default null,
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
    select s.id, 'venue', s.created_at, s.name, s.city, s.province, null::uuid,
      cardinality(s.nearby_venue_ids) + cardinality(s.nearby_submission_ids)
    from private.venue_submissions s where s.status = 'pending'
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

create function public.ownership_review_read(actor_user_id uuid, subject_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  item := private.ownership_review_item(subject_id);
  if item is null then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  return item;
end;
$$;

-- Returns the private object name only to the trusted console server, which
-- downloads and streams it to the verified reviewer. Never a client RPC.
create function public.ownership_review_evidence(actor_user_id uuid, subject_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare evidence text;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  select c.evidence_path into evidence from private.venue_claims c where c.id = subject_id;
  if evidence is null then
    select s.evidence_path into evidence from private.venue_submissions s where s.id = subject_id;
  end if;
  if evidence is null then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  return evidence;
end;
$$;

-- One decision per pending item. Claims: approve|reject. Missing venues:
-- approve_new (admin only: creates a DRAFT listing), merge (an existing listing)
-- or reject. Repeating the recorded decision returns outcome 'existing'.
create function public.ownership_review_decide(actor_user_id uuid, subject_id uuid, decision text,
  target_venue_id uuid, rejection_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  claim private.venue_claims%rowtype; submission private.venue_submissions%rowtype;
  listing public.venue_publication_status; owner_id uuid; venue_target uuid;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  if subject_id is null or decision is null or decision not in ('approve', 'reject', 'approve_new', 'merge')
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

  select s.* into submission from private.venue_submissions s where s.id = subject_id for update;
  if not found then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  if decision = 'approve' then
    raise exception 'Invalid venue decision' using errcode = '22023', hint = 'invalid_input';
  end if;
  if submission.submitter_user_id = actor_user_id then
    raise exception 'Reviewers cannot decide their own submissions' using errcode = '42501', hint = 'self_review';
  end if;
  if submission.status <> 'pending' then
    if (submission.status = 'approved' and decision = 'approve_new' and submission.resolution = 'new')
      or (submission.status = 'approved' and decision = 'merge' and submission.resolution = 'merge'
        and submission.resolved_venue_id = target_venue_id)
      or (submission.status = 'rejected' and decision = 'reject' and submission.review_reason = rejection_reason) then
      return jsonb_build_object('outcome', 'existing', 'item', private.ownership_review_item(subject_id));
    end if;
    raise exception 'Already decided' using errcode = '23505', hint = 'already_decided';
  end if;

  if decision = 'reject' then
    update private.venue_submissions s set status = 'rejected', reviewed_by = actor_user_id, reviewed_at = now(),
      review_reason = rejection_reason where s.id = subject_id;
    insert into private.ownership_audit_events (actor_user_id, action, subject_id)
      values (actor_user_id, 'venue.reject', subject_id);
    return jsonb_build_object('outcome', 'decided', 'item', private.ownership_review_item(subject_id));
  end if;

  owner_id := submission.submitter_user_id;
  perform 1 from public.profiles p where p.id = owner_id for share;
  if not found then raise exception 'Submitter account not found' using errcode = 'P0002', hint = 'not_found'; end if;
  if decision = 'approve_new' then
    -- Creating a listing is directory curation: administrators only.
    perform 1 from private.account_roles r where r.user_id = actor_user_id and r.role = 'admin' for share;
    if not found then
      raise exception 'Administrator authorization required' using errcode = '42501', hint = 'admin_required';
    end if;
    insert into public.venues (name, address_line, city, province, latitude, longitude, claim_status)
      values (submission.name, submission.address_line, submission.city, submission.province,
        submission.latitude, submission.longitude, 'verified')
      returning id into venue_target;
    insert into public.courts (venue_id, name)
      select venue_target, 'Court ' || n from generate_series(1, submission.court_count) n;
    insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
      values (actor_user_id, venue_target, 'directory.create');
  else
    select v.publication_status into listing from public.venues v where v.id = target_venue_id for update;
    if not found or listing = 'suspended' then
      raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
    end if;
    venue_target := target_venue_id;
    update public.venues v set claim_status = 'verified' where v.id = venue_target and v.claim_status <> 'verified';
  end if;
  insert into private.venue_owners (venue_id, user_id, verified_by)
    values (venue_target, owner_id, actor_user_id) on conflict (venue_id, user_id) do nothing;
  update private.venue_submissions s set status = 'approved', reviewed_by = actor_user_id, reviewed_at = now(),
    resolution = case decision when 'approve_new' then 'new' else 'merge' end, resolved_venue_id = venue_target
    where s.id = subject_id;
  insert into private.ownership_audit_events (actor_user_id, action, subject_id, target_venue_id)
    values (actor_user_id, case decision when 'approve_new' then 'venue.approve' else 'venue.merge' end, subject_id, venue_target);
  return jsonb_build_object('outcome', 'decided', 'item', private.ownership_review_item(subject_id));
end;
$$;

-- Submitters see the listing their approved venue submission resolved to.
create or replace function private.owner_submission_item(subject_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('id', c.id, 'kind', 'claim', 'status', c.status, 'venue_id', c.venue_id,
       'name', v.name, 'city', v.city, 'created_at', c.created_at)
     from private.venue_claims c join public.venues v on v.id = c.venue_id where c.id = subject_id),
    (select jsonb_build_object('id', s.id, 'kind', 'venue', 'status', s.status,
       'venue_id', case when s.status = 'approved' then s.resolved_venue_id end,
       'name', s.name, 'city', s.city, 'created_at', s.created_at)
     from private.venue_submissions s where s.id = subject_id));
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
      select s.id, 'venue'::text, s.status::text, case when s.status = 'approved' then s.resolved_venue_id end,
        s.name, s.city, s.created_at
        from private.venue_submissions s where s.submitter_user_id = caller_id
    ) x order by x.created_at desc, x.id limit 50;
end;
$$;

revoke all on function private.require_ownership_reviewer(uuid), private.ownership_submitter(uuid),
  private.ownership_review_item(uuid), private.owner_submission_item(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.ownership_review_queue(uuid, timestamptz, uuid), public.ownership_review_read(uuid, uuid),
  public.ownership_review_evidence(uuid, uuid), public.ownership_review_decide(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.ownership_review_queue(uuid, timestamptz, uuid), public.ownership_review_read(uuid, uuid),
  public.ownership_review_evidence(uuid, uuid), public.ownership_review_decide(uuid, uuid, text, uuid, text) to service_role;
revoke all on function public.my_owner_submissions() from public, anon, authenticated;
grant execute on function public.my_owner_submissions() to authenticated;
notify pgrst, 'reload schema';
