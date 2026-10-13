-- T54b: administrators manage pre-launch registrations (T53/T54) in the console: a list with the registrants'
-- contact details, a fresh claim code at launch (rotation voids the old one; the console server emails it) and
-- erasure for spam or a removal request. Only the console server (service_role) calls these commands, and each
-- rechecks the admin role inside its own transaction. Nothing here publishes a listing or links an owner.

alter table private.venue_registrations
  -- The code version the last delivered email carried, so the console can tell a newer code was not delivered.
  add column email_sent_version integer;
-- Before T54b a code rotated only while no email had been delivered, so a delivered email carried the current code.
update private.venue_registrations set email_sent_version = code_version where email_sent_at is not null;
-- Trusted SQL may still set email_sent_at alone; the console then shows the newest code as not delivered.
alter table private.venue_registrations add constraint venue_registrations_sent_version check (
  email_sent_version is null or (email_sent_at is not null and email_sent_version <= code_version));

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
    'directory.create', 'directory.update', 'directory.publish', 'directory.unpublish', 'directory.suspend', 'directory.import',
    'owner.create', 'owner.update', 'owner.photo_add', 'owner.photo_remove', 'schedule.update', 'policy.update',
    'allocation.block', 'allocation.release', 'schedule.court_update', 'session.create', 'session.cancel', 'directory.delete',
    'prelaunch.register', 'prelaunch.retire', 'prelaunch.code_send', 'prelaunch.erase'));

-- T53, plus the delivered version. Only the version that was sent counts (a rotated code's late success is ignored).
create or replace function public.prelaunch_email_sent(registration_id uuid, sent_version integer) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if registration_id is null or sent_version is null then
    raise exception 'Invalid delivery record' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.venue_registrations r set email_sent_at = clock_timestamp(), email_sent_version = sent_version
    where r.id = registration_id and r.code_version = sent_version and r.status = 'open';
  return found;
end;
$$;

-- Registrations, newest first, 50 a page, with their contact details (admins only). Filters: status and an exact
-- email address. Counts per status follow the email filter.
create function public.prelaunch_admin_read(actor_user_id uuid, status_filter text default null, email_filter text default null,
  after_created_at timestamptz default null, after_id uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare wanted text; rows jsonb;
begin
  perform private.require_directory_admin(actor_user_id);
  wanted := nullif(lower(btrim(email_filter)), '');
  if (after_created_at is null) <> (after_id is null) or (status_filter is not null and status_filter not in ('open', 'claimed', 'erased'))
    or char_length(wanted) > 254 then
    raise exception 'Invalid registration query' using errcode = '22023', hint = 'invalid_input';
  end if;
  with page as (
    select r.*, v.name as venue_name, v.city, v.province, v.publication_status, v.claim_status,
      (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active') as court_count
    from private.venue_registrations r join public.venues v on v.id = r.venue_id
    where (status_filter is null or r.status = status_filter) and (wanted is null or r.email = wanted)
      and (after_id is null or (r.created_at, r.id) < (after_created_at, after_id))
    order by r.created_at desc, r.id desc limit 51
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status, 'registered_at', p.created_at, 'role', p.role,
    'venue', jsonb_build_object('id', p.venue_id, 'name', p.venue_name, 'city', p.city, 'province', p.province,
      'publication_status', p.publication_status, 'claim_status', p.claim_status, 'court_count', p.court_count),
    'contact', case when p.status = 'erased' then null else jsonb_build_object('owner_name', p.owner_name, 'email', p.email,
      'phone', p.phone, 'note', p.note) end,
    'code_version', p.code_version, 'email_sent_at', p.email_sent_at, 'email_sent_version', p.email_sent_version,
    'claimed_at', p.claimed_at, 'submission_id', p.submission_id, 'erased_at', p.erased_at)
    order by p.created_at desc, p.id desc), '[]'::jsonb) into rows from page p;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(rows) with ordinality x(e, n) where n <= 50), '[]'::jsonb),
    'next_cursor', case when jsonb_array_length(rows) > 50 then jsonb_build_object(
      'created_at', rows -> 49 -> 'registered_at', 'id', rows -> 49 -> 'id') else null end,
    'counts', (select jsonb_build_object('open', count(*) filter (where r.status = 'open'),
        'claimed', count(*) filter (where r.status = 'claimed'), 'erased', count(*) filter (where r.status = 'erased'))
      from private.venue_registrations r where wanted is null or r.email = wanted));
end;
$$;

-- A fresh claim code for an open registration (the console made it and sends it after the commit). The old code
-- stops working here. expected_version is the version the admin saw, so a double send or a stale page is refused.
create function public.prelaunch_admin_rotate(actor_user_id uuid, registration_id uuid, expected_version integer, code_hash text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target_id uuid; listing public.venues; item private.venue_registrations;
begin
  perform private.require_directory_admin(actor_user_id);
  if registration_id is null or expected_version is null or code_hash is null or code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid code request' using errcode = '22023', hint = 'invalid_input';
  end if;
  -- Listing first, then the registration: the order of redemption and the privacy sweep.
  select r.venue_id into target_id from private.venue_registrations r where r.id = prelaunch_admin_rotate.registration_id;
  if not found then raise exception 'Registration not found' using errcode = 'P0002', hint = 'not_found'; end if;
  select v.* into listing from public.venues v where v.id = target_id for update;
  select r.* into item from private.venue_registrations r where r.id = prelaunch_admin_rotate.registration_id for update;
  if item.status <> 'open' then
    raise exception 'Registration is claimed or erased' using errcode = '55000', hint = 'not_open';
  end if;
  if item.code_version <> expected_version then
    raise exception 'Registration changed' using errcode = '40001', hint = 'changed';
  end if;
  if listing.publication_status = 'suspended' then
    raise exception 'Listing unavailable' using errcode = 'P0002', hint = 'listing_unavailable';
  end if;
  if listing.claim_status = 'verified' then
    raise exception 'Listing already has a verified owner' using errcode = '23505', hint = 'already_verified';
  end if;
  if exists (select 1 from private.venue_registrations r where r.code_hash = prelaunch_admin_rotate.code_hash) then
    raise exception 'Claim code collision' using errcode = '23505', hint = 'code_collision';
  end if;
  update private.venue_registrations r set code_hash = prelaunch_admin_rotate.code_hash, code_version = r.code_version + 1
    where r.id = item.id returning r.* into item;
  -- Same transaction: an audit failure keeps the old code.
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
    values (actor_user_id, item.venue_id, 'prelaunch.code_send');
  return jsonb_build_object('outcome', 'rotated', 'registration_id', item.id, 'code_version', item.code_version,
    'owner_name', item.owner_name, 'email', item.email, 'venue_name', listing.name);
end;
$$;

-- Spam or a removal request. Open: contacts, note and code erased, a still-draft listing suspended. Claimed: contacts
-- erased only (the draft is the claimant's pending submission; review decides it). Erased: unchanged.
create function public.prelaunch_admin_erase(actor_user_id uuid, registration_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target_id uuid; item private.venue_registrations; suspended boolean := false;
begin
  perform private.require_directory_admin(actor_user_id);
  if registration_id is null then
    raise exception 'Invalid erase request' using errcode = '22023', hint = 'invalid_input';
  end if;
  select r.venue_id into target_id from private.venue_registrations r where r.id = prelaunch_admin_erase.registration_id;
  if not found then raise exception 'Registration not found' using errcode = 'P0002', hint = 'not_found'; end if;
  perform 1 from public.venues v where v.id = target_id for update;
  select r.* into item from private.venue_registrations r where r.id = prelaunch_admin_erase.registration_id for update;
  if item.status = 'erased' then
    return jsonb_build_object('outcome', 'existing', 'registration_id', item.id, 'listing_suspended', false);
  end if;
  update private.venue_registrations r set status = 'erased', owner_name = null, email = null, phone = null,
    note = null, code_hash = null, erased_at = clock_timestamp() where r.id = item.id;
  if item.status = 'open' then
    update public.venues v set publication_status = 'suspended' where v.id = item.venue_id and v.publication_status = 'draft';
    suspended := found;
  end if;
  insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
    values (actor_user_id, item.venue_id, 'prelaunch.erase');
  return jsonb_build_object('outcome', 'erased', 'registration_id', item.id, 'listing_suspended', suspended);
end;
$$;

revoke all on function public.prelaunch_email_sent(uuid, integer),
  public.prelaunch_admin_read(uuid, text, text, timestamptz, uuid), public.prelaunch_admin_rotate(uuid, uuid, integer, text),
  public.prelaunch_admin_erase(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prelaunch_email_sent(uuid, integer),
  public.prelaunch_admin_read(uuid, text, text, timestamptz, uuid), public.prelaunch_admin_rotate(uuid, uuid, integer, text),
  public.prelaunch_admin_erase(uuid, uuid)
  to service_role;
notify pgrst, 'reload schema';
