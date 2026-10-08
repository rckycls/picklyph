-- T32: a scheduled sweep records elapsed rental and group holds as expired and releases their inventory in
-- bounded batches. Cleanup only: reads and commands already treat elapsed holds as expired without it.

-- System expiry has no actor, like T28 group holds released on access.
alter table private.rental_events alter column actor_user_id drop not null,
  add constraint rental_events_system_expire check (actor_user_id is not null or action='expire');
-- Every lifecycle and front-desk action happens at most once per booking, so a second expiry or release
-- (from any path, including trusted SQL) aborts its transaction instead of double-counting.
create unique index rental_events_once on private.rental_events(booking_id,action);
create unique index session_booking_events_once on private.session_booking_events(booking_id,action);
create index rental_bookings_pending on private.rental_bookings(id) where status='pending';
create index session_bookings_pending_expiry on private.session_bookings(expires_at) where status='pending';

-- Rental commands' lock order (venue, court, allocation, booking), but never waits: a locked row is left
-- to the command holding it or to the next run. The clock is read after the locks.
create function private.rental_sweep_hold(target_id uuid) returns text
language plpgsql set search_path='' as $$
declare a private.court_allocations; b private.rental_bookings; at_time timestamptz;
begin
  select x.* into a from private.court_allocations x where x.id=target_id;
  if not found then return 'none'; end if;
  perform 1 from public.venues v where v.id=a.venue_id for share skip locked;
  if not found then return 'skipped'; end if;
  perform 1 from public.courts c where c.id=a.court_id for no key update skip locked;
  if not found then return 'skipped'; end if;
  select x.* into a from private.court_allocations x where x.id=target_id for update skip locked;
  if not found then return 'skipped'; end if;
  select x.* into b from private.rental_bookings x where x.id=target_id for update skip locked;
  if not found then return 'skipped'; end if;
  at_time:=clock_timestamp();
  if b.status<>'pending' or (a.state='expired' or a.expires_at<=at_time) is not true then return 'none'; end if;
  perform private.allocation_release(a.id);
  update private.rental_bookings set status='expired',updated_at=a.expires_at where id=b.id;
  insert into private.rental_events(booking_id,actor_user_id,action) values(b.id,null,'expire');
  return 'expired';
end; $$;

-- Groups hold no court inventory: the session row lock guards the spot counter. Null means skipped.
create function private.session_sweep_holds(target_id uuid) returns integer
language plpgsql set search_path='' as $$
declare s private.open_play_sessions; at_time timestamptz; elapsed integer;
begin
  select x.* into s from private.open_play_sessions x where x.id=target_id;
  if not found then return 0; end if;
  perform 1 from public.venues v where v.id=s.venue_id for share skip locked;
  if not found then return null; end if;
  perform 1 from private.open_play_sessions x where x.id=target_id for update skip locked;
  if not found then return null; end if;
  at_time:=clock_timestamp();
  select count(*)::integer into elapsed from private.session_bookings b
    where b.session_id=target_id and b.status='pending' and b.expires_at<=at_time;
  perform private.session_expire_holds(target_id,at_time);
  return elapsed;
end; $$;

-- One bounded batch: at most batch_limit rentals and batch_limit sessions, oldest expiry first. Each item
-- commits or rolls back on its own, so a failing row never blocks the others; the next run retries it.
create function private.booking_expiry_sweep(batch_limit integer default 100) returns jsonb
language plpgsql set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); target uuid; outcome text; elapsed integer;
  rentals_seen integer:=0; sessions_seen integer:=0; rental_count integer:=0; group_count integer:=0;
  skipped_count integer:=0; failed_count integer:=0;
begin
  if batch_limit is null or batch_limit not between 1 and 1000 then
    raise exception 'Invalid batch' using errcode='22023',hint='invalid_input';
  end if;
  for target in select b.id from private.rental_bookings b join private.court_allocations a on a.id=b.id
    where b.status='pending' and (a.state='expired' or a.expires_at<=at_time)
    order by a.expires_at,b.id limit batch_limit loop
    rentals_seen:=rentals_seen+1;
    begin
      outcome:=private.rental_sweep_hold(target);
      if outcome='expired' then rental_count:=rental_count+1; elsif outcome='skipped' then skipped_count:=skipped_count+1; end if;
    exception when others then
      failed_count:=failed_count+1;
      raise warning 'Hold sweep left rental % for the next run: % %',target,sqlstate,sqlerrm;
    end;
  end loop;
  for target in select b.session_id from private.session_bookings b where b.status='pending' and b.expires_at<=at_time
    group by b.session_id order by min(b.expires_at),b.session_id limit batch_limit loop
    sessions_seen:=sessions_seen+1;
    begin
      elapsed:=private.session_sweep_holds(target);
      if elapsed is null then skipped_count:=skipped_count+1; else group_count:=group_count+elapsed; end if;
    exception when others then
      failed_count:=failed_count+1;
      raise warning 'Hold sweep left session % for the next run: % %',target,sqlstate,sqlerrm;
    end;
  end loop;
  return jsonb_build_object('rentals',rental_count,'groups',group_count,'skipped',skipped_count,'failed',failed_count,
    'more',rentals_seen=batch_limit or sessions_seen=batch_limit);
end; $$;

-- Idempotent: pg_cron updates the named job. Hosted enablement is an operator step (docs/allocations.md).
create function private.booking_expiry_schedule() returns bigint
language plpgsql set search_path='' as $$
begin
  return cron.schedule('booking-expiry-sweep','* * * * *','select private.booking_expiry_sweep(100)');
end; $$;

revoke all on function private.rental_sweep_hold(uuid),private.session_sweep_holds(uuid),
  private.booking_expiry_sweep(integer),private.booking_expiry_schedule() from public,anon,authenticated,service_role;

do $$
begin
  if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then perform private.booking_expiry_schedule(); end if;
end $$;
