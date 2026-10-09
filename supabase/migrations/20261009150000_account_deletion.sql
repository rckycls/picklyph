-- T47: account deletion and retention. The account-deletion Edge function calls
-- account_deletion_begin (one transaction, below), then empties the account's
-- storage folders and deletes the Auth user, whose cascades remove the profile,
-- console roles, claims and submissions. Booking records, snapshots, events,
-- front-desk records and audit rows stay, naming the account by UUID only.
-- See docs/privacy.md for the full data map and retention rules.

-- One row per account whose deletion has started. No FK and no personal data: it
-- outlives the Auth user, so a retry after a lost reply can be confirmed and the
-- triggers below keep refusing new records for the account.
create table private.account_deletions (
  user_id uuid primary key,
  requested_at timestamptz not null default clock_timestamp()
);
alter table private.account_deletions enable row level security;
revoke all on private.account_deletions from public, anon, authenticated, service_role;

-- Once deletion has started nothing new may name the account. Each guarded insert
-- takes the profile's key-share lock first, and account_deletion_begin holds the
-- profile row for update: an insert that got there first commits before begin
-- reads, and a later one sees the deletion record and is refused.
create function private.refuse_deleting_account() returns trigger
language plpgsql security definer set search_path = '' as $$
declare who uuid := (to_jsonb(new) ->> tg_argv[0])::uuid;
begin
  perform 1 from public.profiles p where p.id = who for key share;
  if exists (select 1 from private.account_deletions d where d.user_id = who) then
    raise exception 'Account deletion in progress' using errcode = '42501', hint = 'account_deleted';
  end if;
  return new;
end;
$$;
create trigger court_allocations_account_deleting before insert on private.court_allocations
  for each row execute function private.refuse_deleting_account('requested_by');
create trigger session_bookings_account_deleting before insert on private.session_bookings
  for each row execute function private.refuse_deleting_account('requested_by');
create trigger open_play_sessions_account_deleting before insert on private.open_play_sessions
  for each row execute function private.refuse_deleting_account('created_by');
create trigger venue_owners_account_deleting before insert on private.venue_owners
  for each row execute function private.refuse_deleting_account('user_id');
create trigger account_roles_account_deleting before insert on private.account_roles
  for each row execute function private.refuse_deleting_account('user_id');
create trigger venue_claims_account_deleting before insert on private.venue_claims
  for each row execute function private.refuse_deleting_account('claimant_user_id');
create trigger venue_submissions_account_deleting before insert on private.venue_submissions
  for each row execute function private.refuse_deleting_account('submitter_user_id');
create trigger venue_reports_account_deleting before insert on private.venue_reports
  for each row execute function private.refuse_deleting_account('reporter_user_id');
create trigger venue_photo_requests_account_deleting before insert on private.venue_photo_requests
  for each row execute function private.refuse_deleting_account('uploaded_by');

-- Names a deleted account entered for its groups become "Guest 1", "Guest 2"…;
-- the spot count, price snapshot and status stay for the venue's records.
create function private.erased_names(n integer) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg('Guest ' || i order by i), '[]'::jsonb) from generate_series(1, n) i;
$$;

-- T29 guard plus one exception: erasing a deleting account's player-group names,
-- with nothing else (status, expiry, timestamps, snapshot) changing in the same update.
create or replace function private.session_booking_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if old.source = 'player' and new.participants is distinct from old.participants
    and new.participants = private.erased_names(old.spots)
    and new.request_input = old.request_input || jsonb_build_object('participants', new.participants)
    and (new.id,new.session_id,new.requested_by,new.request_id,new.spots,new.snapshot,new.created_at,new.source,new.status,new.expires_at,new.updated_at)
      is not distinct from (old.id,old.session_id,old.requested_by,old.request_id,old.spots,old.snapshot,old.created_at,old.source,old.status,old.expires_at,old.updated_at)
    and exists (select 1 from private.account_deletions d where d.user_id = old.requested_by) then
    return new;
  end if;
  if (new.id,new.session_id,new.requested_by,new.request_id,new.request_input,new.participants,new.spots,new.snapshot,new.created_at,new.source)
    is distinct from (old.id,old.session_id,old.requested_by,old.request_id,old.request_input,old.participants,old.spots,old.snapshot,old.created_at,old.source)
    or (new.status<>old.status and not (old.status='pending' or (old.status='confirmed' and new.status='cancelled')))
    or (new.status=old.status and new.expires_at is distinct from old.expires_at) then
    raise exception 'Session booking is immutable' using errcode='55000',hint='immutable_booking';
  end if;
  return new;
end; $$;

-- Service-only, called with the server-verified actor. Retry-safe: a second call
-- finds nothing left to change and reports `existing`.
create function public.account_deletion_begin(actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  item record; listing public.venues; result jsonb; failure text; started integer;
  released integer := 0; retired integer := 0; rentals integer := 0; groups integer := 0; erased integer := 0;
begin
  if actor_user_id is null or not exists (select 1 from auth.users u where u.id = actor_user_id) then
    raise exception 'Account not found' using errcode = 'P0002', hint = 'account_required';
  end if;
  -- Serializes with every guarded insert (above) and with ownership approval, which
  -- holds the claimant's profile row while it links the owner.
  perform 1 from public.profiles p where p.id = actor_user_id for update;
  -- Console accounts are removed from their role by another administrator first, so
  -- the console never loses its last administrator to a self-deletion.
  if exists (select 1 from private.account_roles r where r.user_id = actor_user_id) then
    raise exception 'Console role assigned' using errcode = '42501', hint = 'privileged_account';
  end if;
  insert into private.account_deletions (user_id) values (actor_user_id) on conflict (user_id) do nothing;
  get diagnostics started = row_count;

  -- Venues the account manages are released first (listing lock before any booking
  -- lock, like owner commands). Same effect and audit as the T46 revocation, with the
  -- account itself as actor: the last owner leaves the listing unclaimed, which stops
  -- new bookings; existing bookings stay (venue cancellation with refunds is T40).
  for item in select o.venue_id from private.venue_owners o where o.user_id = actor_user_id order by o.venue_id loop
    select v.* into listing from public.venues v where v.id = item.venue_id for update;
    delete from private.venue_owners o where o.venue_id = item.venue_id and o.user_id = actor_user_id;
    if found then
      if listing.claim_status = 'verified' and not exists (select 1 from private.venue_owners o where o.venue_id = item.venue_id) then
        update public.venues v set claim_status = 'unclaimed' where v.id = item.venue_id;
      end if;
      insert into private.moderation_audit_events (actor_user_id, target_venue_id, action, subject_id, reason)
        values (actor_user_id, item.venue_id, 'owner.revoke', actor_user_id, 'owner_request');
      released := released + 1;
    end if;
  end loop;

  -- A pending new-venue draft never publishes: retired exactly like a rejected
  -- submission (the submission row itself goes with the Auth user).
  for item in select s.venue_id from private.venue_submissions s
      where s.submitter_user_id = actor_user_id and s.status = 'pending' and s.venue_id is not null order by s.venue_id loop
    select v.* into listing from public.venues v where v.id = item.venue_id for update;
    if listing.publication_status = 'draft' or listing.claim_status = 'pending' then
      update public.venues v set
        publication_status = case when v.publication_status = 'draft' then 'suspended' else v.publication_status end,
        claim_status = case when v.claim_status = 'pending' then 'unclaimed' else v.claim_status end
        where v.id = item.venue_id;
      if listing.publication_status = 'draft' then
        insert into private.directory_audit_events (actor_user_id, target_venue_id, action)
          values (actor_user_id, item.venue_id, 'directory.suspend');
      end if;
      retired := retired + 1;
    end if;
  end loop;

  -- Upcoming player bookings end as the player's own cancellations, through the same
  -- commands and lock order. A booking that started meanwhile stays as it is.
  for item in select a.id from private.court_allocations a join private.rental_bookings b on b.id = a.id
      where a.requested_by = actor_user_id and a.kind = 'rental' and b.source = 'player'
        and b.status in ('pending', 'confirmed') and a.starts_at > clock_timestamp() order by a.id loop
    begin
      result := public.rental_booking_change(actor_user_id, item.id, 'cancel');
      if result ->> 'outcome' = 'changed' then rentals := rentals + 1; end if;
    exception when others then
      get stacked diagnostics failure = pg_exception_hint;
      if failure is distinct from 'invalid_transition' then raise; end if;
    end;
  end loop;
  for item in select b.id from private.session_bookings b join private.open_play_sessions s on s.id = b.session_id
      where b.requested_by = actor_user_id and b.source = 'player'
        and b.status in ('pending', 'confirmed') and s.starts_at > clock_timestamp() order by b.id loop
    begin
      result := public.session_booking_change(actor_user_id, item.id, 'cancel');
      if result ->> 'outcome' = 'changed' then groups := groups + 1; end if;
    exception when others then
      get stacked diagnostics failure = pg_exception_hint;
      if failure is distinct from 'invalid_transition' then raise; end if;
    end;
  end loop;

  -- Every group the account entered, past or cancelled, loses its names.
  update private.session_bookings b set participants = private.erased_names(b.spots),
      request_input = b.request_input || jsonb_build_object('participants', private.erased_names(b.spots))
    where b.requested_by = actor_user_id and b.source = 'player' and b.participants is distinct from private.erased_names(b.spots);
  get diagnostics erased = row_count;

  return jsonb_build_object('outcome', case when started = 1 then 'started' else 'existing' end,
    'released_venues', released, 'retired_drafts', retired, 'cancelled_rentals', rentals, 'cancelled_groups', groups,
    'erased_groups', erased);
end;
$$;

-- `deleted` only when deletion started here and the Auth user is gone. The Edge
-- function uses it to confirm a retry whose token outlived the account.
create function public.account_deletion_status(target_user_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not exists (select 1 from private.account_deletions d where d.user_id = target_user_id) then 'none'
    when exists (select 1 from auth.users u where u.id = target_user_id) then 'pending'
    else 'deleted' end;
$$;

-- Report free text is kept while reviewers may need it: until 180 days after the
-- decision. Reason, status and dates stay with the moderation history.
create index venue_reports_retention on private.venue_reports (reviewed_at, id) where status <> 'open' and details is not null;
create function private.privacy_retention_sweep(batch_limit integer default 500) returns jsonb
language plpgsql set search_path = '' as $$
declare cleared integer;
begin
  if batch_limit is null or batch_limit not between 1 and 10000 then
    raise exception 'Invalid batch limit' using errcode = '22023', hint = 'invalid_input';
  end if;
  update private.venue_reports r set details = null where r.id in (
    select x.id from private.venue_reports x
      where x.status <> 'open' and x.details is not null and x.reviewed_at < clock_timestamp() - interval '180 days'
      order by x.reviewed_at, x.id limit batch_limit for update skip locked);
  get diagnostics cleared = row_count;
  return jsonb_build_object('report_details', cleared, 'more', cleared = batch_limit);
end;
$$;

-- Idempotent: pg_cron updates the named job (daily 19:17 UTC, 03:17 Manila). Hosted enablement is an operator step (docs/privacy.md).
create function private.privacy_retention_schedule() returns bigint
language plpgsql set search_path = '' as $$
begin
  return cron.schedule('privacy-retention-sweep', '17 19 * * *', 'select private.privacy_retention_sweep(500)');
end;
$$;

revoke all on function private.refuse_deleting_account(), private.erased_names(integer),
  private.privacy_retention_sweep(integer), private.privacy_retention_schedule()
  from public, anon, authenticated, service_role;
revoke all on function public.account_deletion_begin(uuid), public.account_deletion_status(uuid) from public, anon, authenticated;
grant execute on function public.account_deletion_begin(uuid), public.account_deletion_status(uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then perform private.privacy_retention_schedule(); end if;
end $$;

notify pgrst, 'reload schema';
