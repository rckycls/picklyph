-- Console bulk actions (2026-10-13, user request, outside the plan cards). The directory list can filter by
-- publication status, and administrators can permanently delete a listing that was never used: a draft or
-- suspended listing with no court inventory or sessions (in any state), owners, claims, submissions, photos,
-- reports, moderation, merchant or venue-cancellation records. Anything with history stays; suspend it instead.
-- Every deletion is audited, and audit rows have no FK, so they outlive the listing. See docs/directory-curation.md.

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
    'directory.create', 'directory.update', 'directory.publish', 'directory.unpublish', 'directory.suspend', 'directory.import',
    'owner.create', 'owner.update', 'owner.photo_add', 'owner.photo_remove', 'schedule.update', 'policy.update',
    'allocation.block', 'allocation.release', 'schedule.court_update', 'session.create', 'session.cancel', 'directory.delete'));

-- The same pages as before, optionally one publication status only. Called without the filter it answers
-- exactly like the T11 function, so a console on a database without this migration keeps working.
drop function public.directory_admin_read(uuid, uuid, uuid);
create function public.directory_admin_read(actor_user_id uuid, target_venue_id uuid default null, after_id uuid default null,
  publication_filter public.venue_publication_status default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; result jsonb;
begin
  perform private.require_directory_admin(actor_user_id);
  select array_agg(v.id order by v.id) into ids from (
    select v.id from public.venues v where (target_venue_id is null or v.id = target_venue_id)
      and (after_id is null or v.id > after_id) and (publication_filter is null or v.publication_status = publication_filter)
    order by v.id limit 101
  ) v;
  select coalesce(jsonb_agg(private.directory_listing(id) order by id), '[]'::jsonb) into result
    from unnest(ids[1:100]) id;
  return jsonb_build_object('items', result, 'next_cursor', case when cardinality(ids) > 100 then ids[100] else null end);
end;
$$;

-- Why a listing can't be deleted, or null. Inventory and sessions count in every state (cancelled, expired or
-- released too): they are booking history that venues reconcile against.
create function private.directory_delete_blocker(target_venue_id uuid) returns text
language sql stable set search_path = '' as $$
  select case
    when exists (select 1 from private.court_allocations a where a.venue_id = target_venue_id) then 'court_history'
    when exists (select 1 from private.open_play_sessions s where s.venue_id = target_venue_id) then 'session_history'
    when exists (select 1 from private.booking_cancellations b where b.venue_id = target_venue_id) then 'cancellations'
    when exists (select 1 from private.venue_owners o where o.venue_id = target_venue_id) then 'owner'
    when exists (select 1 from private.venue_claims c where c.venue_id = target_venue_id) then 'claim'
    when exists (select 1 from private.venue_submissions s where s.venue_id = target_venue_id or s.resolved_venue_id = target_venue_id) then 'submission'
    when exists (select 1 from public.venue_photos p where p.venue_id = target_venue_id) then 'photos'
    when exists (select 1 from private.venue_reports r where r.venue_id = target_venue_id)
      or exists (select 1 from private.venue_moderation_suspensions m where m.venue_id = target_venue_id) then 'reports'
    when exists (select 1 from private.venue_merchants m where m.venue_id = target_venue_id) then 'merchant'
  end;
$$;

-- Locks the listing first, like every other venue command, so an insert that references it either committed
-- before (and blocks the deletion) or waits and then fails on the missing listing. Schedules, policies, court
-- hours and the private import reference go with it (re-importing that reference creates a new draft).
create function public.directory_admin_delete(actor_user_id uuid, target_venue_id uuid, expected_updated_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_version timestamptz; current_status public.venue_publication_status; blocker text;
begin
  perform private.require_directory_admin(actor_user_id);
  if target_venue_id is null or expected_updated_at is null then raise exception 'Listing and version required' using errcode = '22023'; end if;
  select v.updated_at, v.publication_status into current_version, current_status from public.venues v where v.id = target_venue_id for update;
  if not found then raise exception 'Listing not found' using errcode = 'P0002'; end if;
  if current_version <> expected_updated_at then raise exception 'Listing changed; reload before deleting' using errcode = '40001'; end if;
  if current_status = 'approved' then
    raise exception 'Move the listing to draft or suspend it before deleting' using errcode = '55006', hint = 'listing_published';
  end if;
  blocker := private.directory_delete_blocker(target_venue_id);
  if blocker is not null then
    raise exception 'The listing has history; suspend it instead' using errcode = '55006', hint = 'listing_in_use', detail = blocker;
  end if;
  insert into private.directory_audit_events(actor_user_id, target_venue_id, action) values (actor_user_id, target_venue_id, 'directory.delete');
  delete from public.venues v where v.id = target_venue_id;
  return jsonb_build_object('id', target_venue_id, 'outcome', 'deleted');
end;
$$;

revoke all on function private.directory_delete_blocker(uuid) from public, anon, authenticated, service_role;
revoke all on function public.directory_admin_read(uuid,uuid,uuid,public.venue_publication_status),
  public.directory_admin_delete(uuid,uuid,timestamptz) from public, anon, authenticated;
grant execute on function public.directory_admin_read(uuid,uuid,uuid,public.venue_publication_status),
  public.directory_admin_delete(uuid,uuid,timestamptz) to service_role;
notify pgrst, 'reload schema';
