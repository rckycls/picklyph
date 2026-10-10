-- T40a: current owners cancel future confirmed arrival bookings, or a whole open-play session with its groups and
-- walk-ins, for a fixed reason. Inventory is released in the same transaction, players hear through the T43 outbox
-- and every venue cancellation keeps an immutable audit row. No money moves: arrival payments are only recorded from
-- the start, and cancellation closes at the start. See docs/venue-cancellations.md.

-- One row per booking a venue cancelled: who, why and when. `session_id` names the session cancellation that caused it.
create table private.booking_cancellations (
  booking_id uuid primary key,
  rental_booking_id uuid unique references private.rental_bookings(id) on delete cascade,
  session_booking_id uuid unique references private.session_bookings(id) on delete cascade,
  venue_id uuid not null references public.venues(id) on delete cascade,
  session_id uuid references private.open_play_sessions(id) on delete cascade,
  actor_user_id uuid not null,
  reason text not null check (reason in ('weather','maintenance','venue_closed','schedule_conflict','player_request','other')),
  created_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(rental_booking_id,session_booking_id)=1 and booking_id=coalesce(rental_booking_id,session_booking_id)),
  check (session_id is null or session_booking_id is not null)
);
create index booking_cancellations_venue on private.booking_cancellations(venue_id,created_at);
alter table private.booking_cancellations enable row level security;
revoke all on private.booking_cancellations from public,anon,authenticated,service_role;
create trigger booking_cancellations_immutable before update on private.booking_cancellations
  for each row execute function private.rental_snapshot_immutable();

-- Sessions record who cancelled them and, when anyone held a spot, why. Empty-session cancellations may omit the reason.
alter table private.open_play_sessions
  add column cancel_reason text check (cancel_reason in ('weather','maintenance','venue_closed','schedule_conflict','player_request','other')),
  add column cancelled_by uuid,
  add constraint open_play_sessions_cancel_record check (status='cancelled' or (cancel_reason is null and cancelled_by is null));
create or replace function private.session_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.venue_id,new.created_by,new.request_id,new.request_input,new.snapshot,new.starts_at,new.ends_at,new.capacity,new.created_at)
    is distinct from (old.id,old.venue_id,old.created_by,old.request_id,old.request_input,old.snapshot,old.starts_at,old.ends_at,old.capacity,old.created_at)
    or (old.status='cancelled' and (new.status,new.cancelled_at,new.cancel_reason,new.cancelled_by)
      is distinct from (old.status,old.cancelled_at,old.cancel_reason,old.cancelled_by)) then
    raise exception 'Session snapshot is immutable' using errcode='55000',hint='immutable_session';
  end if;
  return new;
end; $$;

create function private.venue_cancellation_json(target_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('reason',c.reason,'cancelled_at',c.created_at) from private.booking_cancellations c where c.booking_id=target_id;
$$;

-- T31 reads, plus the venue cancellation (null unless the venue cancelled the booking).
create or replace function private.rental_booking_json(target_id uuid, at_time timestamptz) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'source',b.source,'guest_name',b.guest_name,'status',case when b.status='pending'
      and (a.state='expired' or a.expires_at<=at_time) then 'expired' else b.status end,
    'payment_method','arrival','payment_status',case when o.paid_at is null then 'unpaid' else 'paid' end,'created_at',b.created_at,'updated_at',
    case when b.status='pending' and (a.state='expired' or a.expires_at<=at_time) then a.expires_at else b.updated_at end,
    'allocation',private.allocation_json(a,at_time),'snapshot',s.snapshot,'operations',private.booking_operations_json(b.id),
    'venue_cancellation',private.venue_cancellation_json(b.id))
  from private.rental_bookings b join private.court_allocations a on a.id=b.id
    join private.rental_snapshots s on s.allocation_id=b.id left join private.booking_operations o on o.booking_id=b.id where b.id=target_id;
$$;
create or replace function private.session_booking_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'session_id',b.session_id,'source',b.source,
    'status',case when b.status='pending' and b.expires_at<=at_time then 'expired' else b.status end,
    'payment_method','arrival','payment_status',case when o.paid_at is null then 'unpaid' else 'paid' end,
    'participants',b.participants,'spots',b.spots,'expires_at',b.expires_at,'created_at',b.created_at,
    'updated_at',case when b.status='pending' and b.expires_at<=at_time then b.expires_at else b.updated_at end,
    'snapshot',b.snapshot,'operations',private.booking_operations_json(b.id),'venue_cancellation',private.venue_cancellation_json(b.id))
  from private.session_bookings b left join private.booking_operations o on o.booking_id=b.id where b.id=target_id;
$$;
-- Owner session reads gain the cancellation reason.
create or replace function private.session_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.id,'venue_id',s.venue_id,'status',s.status,'created_at',s.created_at,
    'cancelled_at',s.cancelled_at,'cancel_reason',s.cancel_reason,'snapshot',s.snapshot,'reserved_spots',private.session_reserved(s.id,s.reserved_spots,at_time),
    'allocations',coalesce((select jsonb_agg(private.allocation_json(a,at_time) order by a.court_id)
      from private.session_courts c join private.court_allocations a on a.id=c.allocation_id where c.session_id=s.id),'[]'::jsonb))
  from private.open_play_sessions s where s.id=target_id;
$$;

-- A current owner of the booking's venue (also under a moderation suspension) cancels a confirmed player rental or
-- group before it starts. Same lock order as the player and decision commands: venue (share) → owner link → court or
-- session → booking. Retries and racing owners converge on the first venue cancellation and its reason.
create function public.owner_booking_cancel(actor_user_id uuid,target_kind text,target_booking_id uuid,reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; r private.rental_bookings; g private.session_bookings; s private.open_play_sessions;
  venue uuid; at_time timestamptz; outcome text:='changed';
begin
  if actor_user_id is null or target_booking_id is null or target_kind is null or target_kind not in ('rental','session')
    or reason is null or reason not in ('weather','maintenance','venue_closed','schedule_conflict','player_request','other')
    or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Invalid cancellation' using errcode='22023',hint='invalid_input';
  end if;
  if target_kind='rental' then
    select x.* into a from private.court_allocations x join private.rental_bookings y on y.id=x.id where x.id=target_booking_id;
    if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
    venue:=a.venue_id;
    perform 1 from public.venues v where v.id=venue for share;
    perform private.rental_require_owner(actor_user_id,venue);
    perform 1 from public.courts c where c.id=a.court_id for no key update;
    select x.* into a from private.court_allocations x where x.id=target_booking_id for update;
    select x.* into r from private.rental_bookings x where x.id=target_booking_id for update;
  else
    select x.* into g from private.session_bookings x where x.id=target_booking_id;
    if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
    select x.venue_id into venue from private.open_play_sessions x where x.id=g.session_id;
    perform 1 from public.venues v where v.id=venue for share;
    perform private.rental_require_owner(actor_user_id,venue);
    select x.* into s from private.open_play_sessions x where x.id=g.session_id for update;
    select x.* into g from private.session_bookings x where x.id=target_booking_id for update;
  end if;
  if exists(select 1 from private.booking_cancellations c where c.booking_id=target_booking_id) then
    outcome:='existing';
  else
    -- No repayment flow exists, so a booking with front-desk records is never cancelled here.
    if exists(select 1 from private.booking_operations o where o.booking_id=target_booking_id and (o.paid_at is not null or o.attendance<>'none')) then
      raise exception 'Booking has front-desk records' using errcode='55000',hint='payment_collected';
    end if;
    at_time:=clock_timestamp();
    if target_kind='rental' then
      if r.source<>'player' or r.status<>'confirmed' or a.state<>'active' or a.starts_at<=at_time then
        raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
      end if;
      perform private.allocation_release(a.id);
      update private.rental_bookings set status='cancelled',updated_at=clock_timestamp() where id=r.id;
    else
      perform private.session_expire_holds(s.id,at_time);
      if g.source<>'player' or g.status<>'confirmed' or s.status<>'scheduled' or s.starts_at<=at_time then
        raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
      end if;
      update private.session_bookings x set status='cancelled',updated_at=clock_timestamp() where x.id=g.id;
      update private.open_play_sessions x set reserved_spots=x.reserved_spots-g.spots where x.id=s.id;
    end if;
    -- The audit row precedes the event, so the player's alert can name the reason.
    insert into private.booking_cancellations(booking_id,rental_booking_id,session_booking_id,venue_id,actor_user_id,reason)
      values(target_booking_id,case when target_kind='rental' then target_booking_id end,
        case when target_kind='session' then target_booking_id end,venue,actor_user_id,reason);
    if target_kind='rental' then
      insert into private.rental_events(booking_id,actor_user_id,action) values(target_booking_id,actor_user_id,'cancel');
    else
      insert into private.session_booking_events(booking_id,actor_user_id,action) values(target_booking_id,actor_user_id,'cancel');
    end if;
  end if;
  return jsonb_build_object('outcome',outcome,'booking',case target_kind when 'rental' then private.rental_booking_json(target_booking_id,clock_timestamp())
    else private.session_booking_json(target_booking_id,clock_timestamp()) end);
end; $$;

-- T27/T28 cancellation, now also for occupied sessions given a reason (without one they are still refused with
-- `session_has_bookings`): before the start, every pending and confirmed group and walk-in is cancelled with the
-- reason, every court released and the counter zeroed, all in one transaction. Lock order:
-- venue (share) → owner link → courts (UUID order) → session → live bookings (UUID order).
drop function public.owner_session_cancel(uuid,uuid);
create function public.owner_session_cancel(actor_user_id uuid,target_session_id uuid,reason text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.open_play_sessions; allocation uuid; at_time timestamptz; booking private.session_bookings;
begin
  if actor_user_id is null or target_session_id is null
    or reason not in ('weather','maintenance','venue_closed','schedule_conflict','player_request','other') then
    raise exception 'Invalid cancellation' using errcode='22023',hint='invalid_input';
  end if;
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  perform 1 from public.venues v where v.id=saved.venue_id for share;
  perform private.rental_require_owner(actor_user_id,saved.venue_id);
  perform 1 from public.courts c join private.session_courts sc on sc.court_id=c.id
    where sc.session_id=saved.id order by c.id for no key update of c;
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id for update;
  if saved.status='cancelled' then return jsonb_build_object('outcome','existing','session',private.session_json(saved.id,clock_timestamp())); end if;
  at_time:=clock_timestamp();
  perform private.session_expire_holds(saved.id,at_time);
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id;
  -- Without a reason an occupied session is refused as before T40a, so older clients keep their answer.
  if saved.reserved_spots>0 and reason is null then raise exception 'Session has bookings' using errcode='55000',hint='session_has_bookings'; end if;
  if saved.starts_at<=at_time then raise exception 'Session already started' using errcode='55000',hint='session_started'; end if;
  if saved.reserved_spots>0 then
    perform 1 from private.session_bookings b where b.session_id=saved.id and b.status in ('pending','confirmed') order by b.id for update;
    if exists(select 1 from private.session_bookings b join private.booking_operations o on o.booking_id=b.id
      where b.session_id=saved.id and b.status='confirmed' and (o.paid_at is not null or o.attendance<>'none')) then
      raise exception 'Booking has front-desk records' using errcode='55000',hint='payment_collected';
    end if;
    for booking in select b.* from private.session_bookings b where b.session_id=saved.id and b.status in ('pending','confirmed') order by b.id loop
      update private.session_bookings x set status='cancelled',updated_at=clock_timestamp() where x.id=booking.id;
      insert into private.booking_cancellations(booking_id,session_booking_id,venue_id,session_id,actor_user_id,reason)
        values(booking.id,booking.id,saved.venue_id,saved.id,actor_user_id,reason);
      insert into private.session_booking_events(booking_id,actor_user_id,action) values(booking.id,actor_user_id,'cancel');
    end loop;
    update private.open_play_sessions set reserved_spots=0 where id=saved.id;
  end if;
  for allocation in select sc.allocation_id from private.session_courts sc where sc.session_id=saved.id order by sc.court_id loop
    perform private.allocation_release(allocation);
  end loop;
  update private.open_play_sessions set status='cancelled',cancelled_at=clock_timestamp(),cancel_reason=reason,cancelled_by=actor_user_id
    where id=saved.id;
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action) values(actor_user_id,saved.venue_id,'session.cancel');
  return jsonb_build_object('outcome','cancelled','session',private.session_json(saved.id,clock_timestamp()));
end; $$;

-- T43 recipients, plus: a venue cancellation tells the player its reason.
create or replace function private.notification_for_event(src text, source_event bigint, booking uuid, actor uuid, event_action text,
  player uuid, venue uuid, starts timestamptz, booking_status text, amount bigint) returns void
language plpgsql security definer set search_path='' as $$
declare owners uuid[]; event_kind text; audience text; recipients uuid[];
begin
  select coalesce(array_agg(o.user_id), '{}') into owners from private.venue_owners o where o.venue_id = venue;
  case event_action
    when 'request' then
      event_kind := case when booking_status = 'pending' then 'booking.requested' else 'booking.created' end; audience := 'owner'; recipients := owners;
    when 'accept' then event_kind := 'booking.accepted'; audience := 'player'; recipients := array[player];
    when 'decline' then event_kind := 'booking.declined'; audience := 'player'; recipients := array[player];
    when 'expire' then event_kind := 'booking.expired'; audience := 'player'; recipients := array[player];
    when 'cancel' then
      event_kind := 'booking.cancelled';
      if actor = player then audience := 'owner'; recipients := owners; else audience := 'player'; recipients := array[player]; end if;
    when 'payment' then event_kind := 'payment.recorded'; audience := 'player'; recipients := array[player];
    else return;
  end case;
  recipients := array(select r from unnest(recipients) r where r is distinct from actor);
  if cardinality(recipients) = 0 then return; end if;
  perform private.notification_enqueue(src, source_event, event_kind, recipients, jsonb_build_object(
    'audience', audience, 'booking_kind', case src when 'rental' then 'rental' else 'group' end, 'booking_id', booking,
    'venue_id', venue, 'venue_name', (select v.name from public.venues v where v.id = venue),
    'starts_at', to_char(starts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
    || case when event_action = 'payment' and amount is not null then jsonb_build_object('amount_centavos', amount) else '{}'::jsonb end
    || coalesce((select jsonb_build_object('reason', c.reason) from private.booking_cancellations c
      where c.booking_id = booking and event_action = 'cancel' and audience = 'player'), '{}'::jsonb));
end; $$;

revoke all on function private.session_immutable(),private.venue_cancellation_json(uuid),private.rental_booking_json(uuid,timestamptz),
  private.session_booking_json(uuid,timestamptz),private.session_json(uuid,timestamptz),
  private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamptz,text,bigint) from public,anon,authenticated,service_role;
revoke all on function public.owner_booking_cancel(uuid,text,uuid,text),public.owner_session_cancel(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.owner_booking_cancel(uuid,text,uuid,text),public.owner_session_cancel(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
