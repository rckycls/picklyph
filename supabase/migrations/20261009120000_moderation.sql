-- T46: public listing reports, moderation decisions, audited suspension and
-- reinstatement, and audited owner revocation. Admins and moderators act only
-- through service-only commands that take a server-verified actor and lock the
-- actor's current role row until commit. No moderation path grants ownership,
-- roles, directory curation or booking/payment authority, and T08's unaudited
-- direct owner assignment is dropped. Report/audit retention belongs to T47.

-- Reports: signed-in players flag a published listing. Fixed reasons; the only
-- free text is the optional details, shown to reviewers and never to owners.
create table private.venue_reports (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  -- Kept as an anonymous report if the account is deleted; T47 decides retention.
  reporter_user_id uuid references public.profiles(id) on delete set null,
  request_id uuid not null,
  reason text not null check (reason in ('wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate', 'unsafe', 'other')),
  details text check (details is null or (details = btrim(details) and char_length(details) between 1 and 500
    and translate(details, E'\n', '') !~ '[[:cntrl:]]')),
  status text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint venue_reports_reviewed check ((status = 'open') = (reviewed_at is null)),
  unique (reporter_user_id, request_id)
);
create unique index venue_reports_one_open on private.venue_reports (reporter_user_id, venue_id) where status = 'open';
create index venue_reports_open on private.venue_reports (venue_id, created_at) where status = 'open';
create index venue_reports_venue on private.venue_reports (venue_id, created_at desc, id);
alter table private.venue_reports enable row level security;
revoke all on private.venue_reports from public, anon, authenticated, service_role;

-- Present only while moderation keeps a listing suspended, so reinstatement can
-- never publish a retired owner draft or undo an administrator's suspension.
create table private.venue_moderation_suspensions (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  reason text not null check (reason in ('wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate', 'unsafe', 'other')),
  suspended_by uuid references auth.users(id) on delete set null,
  suspended_at timestamptz not null default clock_timestamp()
);
alter table private.venue_moderation_suspensions enable row level security;
revoke all on private.venue_moderation_suspensions from public, anon, authenticated, service_role;

-- Any path out of `suspended` (moderation, directory curation, trusted SQL) ends it.
create function private.clear_moderation_suspension() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.venue_moderation_suspensions s where s.venue_id = new.id;
  return null;
end;
$$;
create trigger venues_clear_moderation_suspension after update of publication_status on public.venues
  for each row when (old.publication_status = 'suspended' and new.publication_status <> 'suspended')
  execute function private.clear_moderation_suspension();

-- Same immutable/no-FK pattern as T12: history survives account/venue deletion.
create table private.moderation_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null,
  target_venue_id uuid not null,
  action text not null check (action in ('report.submit', 'report.dismiss', 'report.resolve',
    'venue.suspend', 'venue.reinstate', 'owner.revoke')),
  -- The report, or the account whose owner link was revoked.
  subject_id uuid,
  -- Fixed codes only, never free text.
  reason text check (reason is null or reason in ('wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate',
    'unsafe', 'other', 'not_owner', 'ownership_ended', 'owner_request', 'abuse')),
  occurred_at timestamptz not null default clock_timestamp(),
  check ((action in ('venue.suspend', 'venue.reinstate')) = (subject_id is null)),
  check ((action in ('venue.suspend', 'owner.revoke')) = (reason is not null))
);
create index moderation_audit_events_venue on private.moderation_audit_events (target_venue_id, id);
create index moderation_audit_events_actor on private.moderation_audit_events (actor_user_id, id);
alter table private.moderation_audit_events enable row level security;
revoke all on private.moderation_audit_events from public, anon, authenticated, service_role;
revoke all on sequence private.moderation_audit_events_id_seq from public, anon, authenticated, service_role;

-- Hold the assignment until commit, so revocation cannot race a decision.
create function private.require_moderator(actor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform 1 from private.account_roles r where r.user_id = actor_id and r.role in ('admin', 'moderator') for share;
  if not found then
    raise exception 'Moderation authorization required' using errcode = '42501', hint = 'moderator_required';
  end if;
end;
$$;

-- Owners, claimants and draft creators never moderate that listing.
create function private.has_venue_stake(actor_id uuid, target_venue_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from private.venue_owners o where o.user_id = actor_id and o.venue_id = target_venue_id)
    or exists (select 1 from private.venue_claims c where c.claimant_user_id = actor_id and c.venue_id = target_venue_id)
    or exists (select 1 from private.venue_submissions s where s.submitter_user_id = actor_id and s.venue_id = target_venue_id);
$$;

create function private.venue_report_item(report private.venue_reports) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', report.id, 'venue_id', report.venue_id, 'reason', report.reason, 'details', report.details,
    'status', report.status, 'created_at', report.created_at);
$$;

create function public.venue_report_submit(actor_user_id uuid, report_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  request uuid; target uuid; report_reason text; report_details text;
  listing public.venue_publication_status; existing private.venue_reports; created private.venue_reports;
begin
  if jsonb_typeof(report_input) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(report_input) k) is distinct from array['details', 'reason', 'request_id', 'venue_id']
    or jsonb_typeof(report_input -> 'request_id') is distinct from 'string' or (report_input ->> 'request_id') !~ uuid_pattern
    or jsonb_typeof(report_input -> 'venue_id') is distinct from 'string' or (report_input ->> 'venue_id') !~ uuid_pattern
    or jsonb_typeof(report_input -> 'reason') is distinct from 'string'
    or (report_input ->> 'reason') not in ('wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate', 'unsafe', 'other')
    or jsonb_typeof(report_input -> 'details') not in ('string', 'null') then
    raise exception 'Invalid report' using errcode = '22023', hint = 'invalid_input';
  end if;
  request := (report_input ->> 'request_id')::uuid;
  target := (report_input ->> 'venue_id')::uuid;
  report_reason := report_input ->> 'reason';
  report_details := report_input ->> 'details';
  if report_details is not null and (report_details <> btrim(report_details) or char_length(report_details) not between 1 and 500
    or translate(report_details, E'\n', '') ~ '[[:cntrl:]]') then
    raise exception 'Invalid report details' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- A real account, locked until commit so deletion cannot race the insert.
  perform 1 from public.profiles p where p.id = actor_user_id for share;
  if not found then
    raise exception 'Account required' using errcode = '42501', hint = 'account_required';
  end if;
  -- One reporter at a time: retries, the one-open rule and the cap stay exact.
  perform pg_advisory_xact_lock(hashtextextended('pickly.venue_report:' || actor_user_id::text, 0));

  select r.* into existing from private.venue_reports r where r.reporter_user_id = actor_user_id and r.request_id = request;
  if found then
    if existing.venue_id = target and existing.reason = report_reason and existing.details is not distinct from report_details then
      return jsonb_build_object('outcome', 'existing', 'report', private.venue_report_item(existing));
    end if;
    raise exception 'Request already used' using errcode = '23505', hint = 'request_reused';
  end if;
  select v.publication_status into listing from public.venues v where v.id = target;
  if listing is distinct from 'approved' then
    raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'venue_unavailable';
  end if;
  if exists (select 1 from private.venue_reports r where r.reporter_user_id = actor_user_id and r.venue_id = target and r.status = 'open') then
    raise exception 'Already reported' using errcode = '23505', hint = 'already_reported';
  end if;
  if (select count(*) from private.venue_reports r where r.reporter_user_id = actor_user_id and r.status = 'open') >= 20 then
    raise exception 'Too many open reports' using errcode = '54000', hint = 'too_many_reports';
  end if;
  insert into private.venue_reports (venue_id, reporter_user_id, request_id, reason, details)
    values (target, actor_user_id, request, report_reason, report_details) returning * into created;
  -- Same transaction: an audit failure aborts the report.
  insert into private.moderation_audit_events (actor_user_id, target_venue_id, action, subject_id)
    values (actor_user_id, target, 'report.submit', created.id);
  return jsonb_build_object('outcome', 'created', 'report', private.venue_report_item(created));
end;
$$;

-- Reviewer snapshot of one listing: current state, owners, latest reports and history.
create function private.moderation_item(target_venue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'venue', jsonb_build_object('id', v.id, 'name', v.name, 'address_line', v.address_line, 'city', v.city, 'province', v.province,
      'latitude', v.latitude, 'longitude', v.longitude, 'publication_status', v.publication_status, 'claim_status', v.claim_status,
      'active_court_count', (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active')),
    'suspension', (select jsonb_build_object('reason', s.reason, 'suspended_by', s.suspended_by, 'suspended_at', s.suspended_at)
      from private.venue_moderation_suspensions s where s.venue_id = v.id),
    'owners', coalesce((select jsonb_agg(jsonb_build_object('user_id', o.user_id, 'display_name', p.display_name, 'verified_at', o.verified_at)
      order by o.verified_at, o.user_id) from private.venue_owners o join public.profiles p on p.id = o.user_id where o.venue_id = v.id), '[]'::jsonb),
    'open_reports', (select count(*) from private.venue_reports r where r.venue_id = v.id and r.status = 'open'),
    'reports', coalesce((select jsonb_agg(x.item order by x.open desc, x.created_at desc, x.id) from (
      select r.status = 'open' as open, r.created_at, r.id, private.venue_report_item(r) || jsonb_build_object('reviewed_at', r.reviewed_at,
        'reporter', case when r.reporter_user_id is null then null
          else jsonb_build_object('id', r.reporter_user_id, 'display_name', p.display_name) end) as item
      from private.venue_reports r left join public.profiles p on p.id = r.reporter_user_id
      where r.venue_id = v.id order by r.status = 'open' desc, r.created_at desc, r.id limit 100) x), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(x.item order by x.id desc) from (
      select e.id, jsonb_build_object('id', e.id::text, 'action', e.action, 'actor_user_id', e.actor_user_id,
        'subject_id', e.subject_id, 'reason', e.reason, 'occurred_at', e.occurred_at) as item
      from private.moderation_audit_events e where e.target_venue_id = v.id order by e.id desc limit 50) x), '[]'::jsonb))
  from public.venues v where v.id = target_venue_id;
$$;

-- Listings with open reports, oldest open report first, 50 per keyset page.
create function public.moderation_queue(actor_user_id uuid, after_created_at timestamptz default null, after_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare page_rows jsonb; total integer;
begin
  perform private.require_moderator(actor_user_id);
  if (after_created_at is null) <> (after_id is null) then
    raise exception 'Invalid queue cursor' using errcode = '22023', hint = 'invalid_input';
  end if;
  select count(distinct r.venue_id) into total from private.venue_reports r where r.status = 'open';
  with open as (
    select r.venue_id, min(r.created_at) as oldest, count(*) as reports, array_agg(distinct r.reason order by r.reason) as reasons
    from private.venue_reports r where r.status = 'open' group by r.venue_id
  ), page as (
    select o.*, v.name, v.city, v.province, v.publication_status, v.claim_status
    from open o join public.venues v on v.id = o.venue_id
    where after_created_at is null or (o.oldest, o.venue_id) > ($2, $3)
    order by o.oldest, o.venue_id limit 51
  )
  select coalesce(jsonb_agg(jsonb_build_object('venue_id', p.venue_id, 'name', p.name, 'city', p.city, 'province', p.province,
    'publication_status', p.publication_status, 'claim_status', p.claim_status, 'open_reports', p.reports,
    'reasons', to_jsonb(p.reasons), 'oldest_report_at', p.oldest) order by p.oldest, p.venue_id), '[]'::jsonb)
    into page_rows from page p;
  return jsonb_build_object('items', (select coalesce(jsonb_agg(e order by n), '[]'::jsonb)
      from jsonb_array_elements(page_rows) with ordinality as x(e, n) where n <= 50),
    'next_cursor', case when jsonb_array_length(page_rows) > 50
      then jsonb_build_object('created_at', page_rows -> 49 ->> 'oldest_report_at', 'id', page_rows -> 49 ->> 'venue_id') end,
    'open_total', total);
end;
$$;

create function public.moderation_venue_read(actor_user_id uuid, target_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  perform private.require_moderator(actor_user_id);
  item := private.moderation_item(target_venue_id);
  if item is null then
    raise exception 'Listing not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  return item;
end;
$$;

-- dismiss|resolve close the reports the reviewer saw; suspend (fixed reason) takes a
-- published listing down and resolves them; reinstate undoes a moderation suspension.
-- Lock order: role row, listing, reports (the same listing-first order as bookings).
create function public.moderation_decide(actor_user_id uuid, target_venue_id uuid, decision text, reason text, report_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare listing public.venues; ids uuid[] := coalesce(report_ids, '{}'); closing text; closed integer; changed boolean := false;
begin
  perform private.require_moderator(actor_user_id);
  if target_venue_id is null or decision is null or decision not in ('dismiss', 'resolve', 'suspend', 'reinstate')
    or (decision = 'suspend') <> (reason is not null)
    or (reason is not null and reason not in ('wrong_details', 'closed', 'not_a_venue', 'duplicate', 'inappropriate', 'unsafe', 'other'))
    or cardinality(ids) > 100 or array_position(ids, null) is not null
    or cardinality(ids) <> (select count(distinct x) from unnest(ids) x)
    or (decision in ('dismiss', 'resolve') and cardinality(ids) = 0)
    or (decision = 'reinstate' and cardinality(ids) > 0) then
    raise exception 'Invalid moderation decision' using errcode = '22023', hint = 'invalid_input';
  end if;
  select v.* into listing from public.venues v where v.id = target_venue_id for update;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if private.has_venue_stake(actor_user_id, target_venue_id) then
    raise exception 'Reviewers cannot moderate their own listings' using errcode = '42501', hint = 'self_moderation';
  end if;
  closing := case decision when 'dismiss' then 'dismissed' else 'resolved' end;
  if cardinality(ids) > 0 then
    perform 1 from private.venue_reports r where r.id = any(ids) order by r.id for update;
    if (select count(*) from private.venue_reports r where r.id = any(ids) and r.venue_id = target_venue_id) <> cardinality(ids) then
      raise exception 'Reports must belong to this listing' using errcode = '22023', hint = 'invalid_input';
    end if;
    if exists (select 1 from private.venue_reports r where r.id = any(ids) and r.status not in ('open', closing)) then
      raise exception 'Report already decided' using errcode = '23505', hint = 'already_decided';
    end if;
  end if;

  if decision = 'suspend' then
    if listing.publication_status = 'approved' then
      update public.venues v set publication_status = 'suspended' where v.id = target_venue_id;
      insert into private.venue_moderation_suspensions (venue_id, reason, suspended_by) values (target_venue_id, reason, actor_user_id);
      -- The directory history keeps every status change; the moderation history keeps why.
      insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (actor_user_id, target_venue_id, 'directory.suspend');
      insert into private.moderation_audit_events (actor_user_id, target_venue_id, action, reason)
        values (actor_user_id, target_venue_id, 'venue.suspend', reason);
      changed := true;
    elsif not exists (select 1 from private.venue_moderation_suspensions s where s.venue_id = target_venue_id) then
      raise exception 'Only published listings can be suspended here' using errcode = '55000', hint = 'not_published';
    end if;
  elsif decision = 'reinstate' then
    if exists (select 1 from private.venue_moderation_suspensions s where s.venue_id = target_venue_id) then
      if not exists (select 1 from public.courts c where c.venue_id = target_venue_id and c.status = 'active') then
        raise exception 'Published listings need an active court' using errcode = '22023', hint = 'active_court_required';
      end if;
      -- The trigger removes the moderation marker.
      update public.venues v set publication_status = 'approved' where v.id = target_venue_id;
      insert into private.directory_audit_events (actor_user_id, target_venue_id, action) values (actor_user_id, target_venue_id, 'directory.publish');
      insert into private.moderation_audit_events (actor_user_id, target_venue_id, action) values (actor_user_id, target_venue_id, 'venue.reinstate');
      changed := true;
    elsif listing.publication_status <> 'approved' then
      raise exception 'Only a moderation suspension can be reinstated here' using errcode = '55000', hint = 'not_moderation_suspension';
    end if;
  end if;

  with done as (
    update private.venue_reports r set status = closing, reviewed_by = actor_user_id, reviewed_at = clock_timestamp()
    where r.id = any(ids) and r.status = 'open' returning r.id
  )
  insert into private.moderation_audit_events (actor_user_id, target_venue_id, action, subject_id)
    select actor_user_id, target_venue_id, case closing when 'dismissed' then 'report.dismiss' else 'report.resolve' end, d.id from done d;
  get diagnostics closed = row_count;
  return jsonb_build_object('outcome', case when changed or closed > 0 then 'decided' else 'existing' end,
    'item', private.moderation_item(target_venue_id));
end;
$$;

-- Replaces T08's unaudited revocation. Removing the last owner unclaims the listing,
-- so new bookings stop until a reviewed claim verifies someone again.
create function public.ownership_revoke(actor_user_id uuid, target_venue_id uuid, owner_user_id uuid, reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare listing public.venues; removed integer;
begin
  perform private.require_moderator(actor_user_id);
  if target_venue_id is null or owner_user_id is null or reason is null
    or reason not in ('not_owner', 'ownership_ended', 'owner_request', 'abuse', 'other') then
    raise exception 'Invalid revocation' using errcode = '22023', hint = 'invalid_input';
  end if;
  select v.* into listing from public.venues v where v.id = target_venue_id for update;
  if not found then
    raise exception 'Listing not found' using errcode = 'P0002', hint = 'not_found';
  end if;
  if private.has_venue_stake(actor_user_id, target_venue_id) then
    raise exception 'Reviewers cannot moderate their own listings' using errcode = '42501', hint = 'self_moderation';
  end if;
  delete from private.venue_owners o where o.venue_id = target_venue_id and o.user_id = owner_user_id;
  get diagnostics removed = row_count;
  if removed = 0 then
    return jsonb_build_object('outcome', 'existing', 'item', private.moderation_item(target_venue_id));
  end if;
  if listing.claim_status = 'verified' and not exists (select 1 from private.venue_owners o where o.venue_id = target_venue_id) then
    update public.venues v set claim_status = 'unclaimed' where v.id = target_venue_id;
  end if;
  insert into private.moderation_audit_events (actor_user_id, target_venue_id, action, subject_id, reason)
    values (actor_user_id, target_venue_id, 'owner.revoke', owner_user_id, reason);
  return jsonb_build_object('outcome', 'decided', 'item', private.moderation_item(target_venue_id));
end;
$$;

-- Ownership is granted only by the audited T17 review (or trusted operator SQL).
drop function public.set_verified_venue_owner(uuid, uuid, uuid, boolean);

revoke all on function private.clear_moderation_suspension(), private.require_moderator(uuid), private.has_venue_stake(uuid, uuid),
  private.venue_report_item(private.venue_reports), private.moderation_item(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.venue_report_submit(uuid, jsonb), public.moderation_queue(uuid, timestamptz, uuid),
  public.moderation_venue_read(uuid, uuid), public.moderation_decide(uuid, uuid, text, text, uuid[]),
  public.ownership_revoke(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.venue_report_submit(uuid, jsonb), public.moderation_queue(uuid, timestamptz, uuid),
  public.moderation_venue_read(uuid, uuid), public.moderation_decide(uuid, uuid, text, text, uuid[]),
  public.ownership_revoke(uuid, uuid, uuid, text) to service_role;

notify pgrst, 'reload schema';
