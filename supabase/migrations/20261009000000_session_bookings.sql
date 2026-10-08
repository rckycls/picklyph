-- T28: named-group arrival reservations share one locked spot inventory per session.
create table private.session_bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references private.open_play_sessions(id) on delete cascade,
  requested_by uuid not null,
  request_id uuid not null,
  request_input jsonb not null,
  participants jsonb not null,
  spots integer not null check (spots between 1 and 200),
  snapshot jsonb not null,
  status text not null check (status in ('pending','confirmed','declined','cancelled','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(requested_by,request_id),
  check (jsonb_typeof(participants)='array' and jsonb_array_length(participants)=spots),
  check (status<>'pending' or expires_at is not null),
  check (status<>'confirmed' or expires_at is null)
);
-- One live group per player per session, so the group limit cannot be split across bookings.
create unique index session_bookings_one_live on private.session_bookings(session_id,requested_by) where status in ('pending','confirmed');
create index session_bookings_pending on private.session_bookings(session_id,expires_at) where status='pending';
create index session_bookings_history on private.session_bookings(requested_by,id);
create table private.session_booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references private.session_bookings(id) on delete cascade,
  -- Null only when an elapsed hold is released on access, without a requesting actor.
  actor_user_id uuid,
  action text not null check (action in ('request','accept','decline','cancel','expire')),
  created_at timestamptz not null default clock_timestamp(),
  check (actor_user_id is not null or action='expire')
);
create index session_booking_events_booking on private.session_booking_events(booking_id,id);
alter table private.session_bookings enable row level security;
alter table private.session_booking_events enable row level security;
revoke all on private.session_bookings,private.session_booking_events from public,anon,authenticated,service_role;
revoke all on sequence private.session_booking_events_id_seq from public,anon,authenticated,service_role;
create trigger session_booking_events_immutable before update on private.session_booking_events
  for each row execute function private.rental_snapshot_immutable();

create function private.session_booking_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.session_id,new.requested_by,new.request_id,new.request_input,new.participants,new.spots,new.snapshot,new.created_at)
    is distinct from (old.id,old.session_id,old.requested_by,old.request_id,old.request_input,old.participants,old.spots,old.snapshot,old.created_at)
    or (new.status<>old.status and not (old.status='pending' or (old.status='confirmed' and new.status='cancelled')))
    or (new.status=old.status and new.expires_at is distinct from old.expires_at) then
    raise exception 'Session booking is immutable' using errcode='55000',hint='immutable_booking';
  end if;
  return new;
end; $$;
create trigger session_booking_guard before update on private.session_bookings for each row execute function private.session_booking_guard();

-- Live spots: stored counter minus pending holds that elapsed before any write released them.
create function private.session_reserved(target_id uuid,stored integer,at_time timestamptz) returns integer
language sql stable set search_path='' as $$
  select stored-coalesce((select sum(b.spots) from private.session_bookings b
    where b.session_id=target_id and b.status='pending' and b.expires_at<=at_time),0)::integer;
$$;

-- Caller MUST hold the session row lock (venue share, then session for update).
create function private.session_expire_holds(target_id uuid,at_time timestamptz) returns void
language plpgsql set search_path='' as $$
declare released integer;
begin
  select coalesce(sum(b.spots),0)::integer into released from private.session_bookings b
    where b.session_id=target_id and b.status='pending' and b.expires_at<=at_time;
  if released=0 then return; end if;
  insert into private.session_booking_events(booking_id,actor_user_id,action) select b.id,null,'expire'
    from private.session_bookings b where b.session_id=target_id and b.status='pending' and b.expires_at<=at_time order by b.id;
  update private.session_bookings b set status='expired',updated_at=b.expires_at
    where b.session_id=target_id and b.status='pending' and b.expires_at<=at_time;
  update private.open_play_sessions s set reserved_spots=s.reserved_spots-released where s.id=target_id;
end; $$;

-- Owner reads (T27) and empty-session cancellation now see the effective live count.
create or replace function private.session_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.id,'venue_id',s.venue_id,'status',s.status,'created_at',s.created_at,
    'cancelled_at',s.cancelled_at,'snapshot',s.snapshot,'reserved_spots',private.session_reserved(s.id,s.reserved_spots,at_time),
    'allocations',coalesce((select jsonb_agg(private.allocation_json(a,at_time) order by a.court_id)
      from private.session_courts c join private.court_allocations a on a.id=c.allocation_id where c.session_id=s.id),'[]'::jsonb))
  from private.open_play_sessions s where s.id=target_id;
$$;

-- Player view: no participant names, owner identity or internal revisions.
create function private.session_offer_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.id,'venue_id',s.venue_id,'status',s.status,
    'snapshot',s.snapshot-'schedule_revision'-'court_hours_revisions'-'policy_revision',
    'available_spots',case when s.status='scheduled' and s.starts_at>at_time
      then s.capacity-private.session_reserved(s.id,s.reserved_spots,at_time) else 0 end)
  from private.open_play_sessions s where s.id=target_id;
$$;

create function private.session_booking_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'session_id',b.session_id,
    'status',case when b.status='pending' and b.expires_at<=at_time then 'expired' else b.status end,
    'payment_method','arrival','payment_status','unpaid','participants',b.participants,'spots',b.spots,
    'expires_at',b.expires_at,'created_at',b.created_at,
    'updated_at',case when b.status='pending' and b.expires_at<=at_time then b.expires_at else b.updated_at end,
    'snapshot',b.snapshot)
  from private.session_bookings b where b.id=target_id;
$$;

-- Venue rows that may take new group bookings.
create function private.session_venue_bookable(listing public.venues) returns boolean language sql stable set search_path='' as $$
  select coalesce(listing.publication_status='approved' and listing.claim_status='verified'
    and exists(select 1 from private.venue_owners o where o.venue_id=listing.id),false);
$$;

create function public.session_booking_request(actor_user_id uuid,booking_input jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare target uuid; request uuid; names jsonb; expected numeric; canonical jsonb; existing private.session_bookings;
  s private.open_play_sessions; listing public.venues; at_time timestamptz; spots integer; total numeric;
  hold timestamptz; booking_id uuid;
begin
  if actor_user_id is null or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Player required' using errcode='42501',hint='player_required';
  end if;
  if jsonb_typeof(booking_input) is distinct from 'object'
    or not booking_input ?& array['session_id','request_id','participants','expected_total_centavos']
    or (select count(*) from jsonb_object_keys(booking_input))<>4
    or jsonb_typeof(booking_input->'session_id') is distinct from 'string'
    or jsonb_typeof(booking_input->'request_id') is distinct from 'string'
    or jsonb_typeof(booking_input->'expected_total_centavos') is distinct from 'number'
    or jsonb_typeof(booking_input->'participants') is distinct from 'array'
    or jsonb_array_length(booking_input->'participants') not between 1 and 200
    or exists(select 1 from jsonb_array_elements(booking_input->'participants') x where jsonb_typeof(x)<>'string') then
    raise exception 'Invalid booking' using errcode='22023',hint='invalid_input';
  end if;
  begin
    target:=(booking_input->>'session_id')::uuid; request:=(booking_input->>'request_id')::uuid;
    expected:=(booking_input->>'expected_total_centavos')::numeric;
  exception when others then raise exception 'Invalid booking' using errcode='22023',hint='invalid_input'; end;
  select jsonb_agg(btrim(p.x) order by p.n) into names from jsonb_array_elements_text(booking_input->'participants') with ordinality p(x,n);
  if target is null or request is null or expected<0 or expected<>trunc(expected) or expected>9007199254740991
    or exists(select 1 from jsonb_array_elements_text(names) x where char_length(x) not between 1 and 60 or x~'[[:cntrl:]]')
    or (select count(distinct lower(x)) from jsonb_array_elements_text(names) x)<>jsonb_array_length(names) then
    raise exception 'Invalid booking' using errcode='22023',hint='invalid_input';
  end if;
  canonical:=jsonb_build_object('session_id',target,'request_id',request,'participants',names,'expected_total_centavos',expected);
  -- Serialize a player's retry key even when competing attempts name different sessions.
  perform pg_advisory_xact_lock(hashtextextended('session-booking:'||actor_user_id::text||':'||request::text,0));
  select b.* into existing from private.session_bookings b where b.requested_by=actor_user_id and b.request_id=request;
  if found then
    if existing.request_input<>canonical then raise exception 'Request already used' using errcode='23505',hint='request_reused'; end if;
    -- Wait for a concurrent lifecycle command on the session, then return one consistent read.
    perform 1 from public.venues v join private.open_play_sessions x on x.venue_id=v.id where x.id=existing.session_id for share of v;
    perform 1 from private.open_play_sessions x where x.id=existing.session_id for share;
    return jsonb_build_object('outcome','existing','booking',private.session_booking_json(existing.id,clock_timestamp()));
  end if;
  select x.* into s from private.open_play_sessions x where x.id=target;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  select v.* into listing from public.venues v where v.id=s.venue_id for share;
  select x.* into s from private.open_play_sessions x where x.id=target for update;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  at_time:=clock_timestamp();
  perform private.session_expire_holds(s.id,at_time);
  select x.* into s from private.open_play_sessions x where x.id=target;
  if not private.session_venue_bookable(listing) then
    raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
  end if;
  if s.status<>'scheduled' then raise exception 'Session cancelled' using errcode='55000',hint='session_cancelled'; end if;
  if s.starts_at<=at_time then raise exception 'Session already started' using errcode='55000',hint='session_started'; end if;
  -- The immutable session snapshot, never the venue's current policy, governs the group.
  if s.snapshot->'policy'->>'payment'='online' then
    raise exception 'Arrival unavailable' using errcode='23514',hint='arrival_unavailable';
  end if;
  spots:=jsonb_array_length(names);
  if spots>(s.snapshot->>'group_limit')::integer then
    raise exception 'Group too large' using errcode='23514',hint='group_limit_exceeded';
  end if;
  total:=(s.snapshot->>'price_centavos')::numeric*spots;
  if expected<>total then raise exception 'Review changed total' using errcode='40001',hint='stale_quote'; end if;
  if exists(select 1 from private.session_bookings b where b.session_id=s.id and b.requested_by=actor_user_id and b.status in ('pending','confirmed')) then
    raise exception 'Already booked' using errcode='23505',hint='already_booked';
  end if;
  if s.reserved_spots+spots>s.capacity then raise exception 'Session full' using errcode='23514',hint='session_full'; end if;
  if s.snapshot->'policy'->>'confirmation'='approval' then
    hold:=least(at_time+make_interval(mins=>(s.snapshot->>'approval_hold_minutes')::integer),s.starts_at);
  end if;
  insert into private.session_bookings(session_id,requested_by,request_id,request_input,participants,spots,snapshot,status,expires_at)
    values(s.id,actor_user_id,request,canonical,names,spots,jsonb_build_object('venue_id',s.venue_id,
      'title',s.snapshot->'title','court_ids',s.snapshot->'court_ids','starts_at',s.snapshot->'starts_at','ends_at',s.snapshot->'ends_at',
      'price_centavos',s.snapshot->'price_centavos','spots',spots,'total_centavos',total,'currency','PHP','timezone','Asia/Manila',
      'policy',s.snapshot->'policy','policy_revision',s.snapshot->'policy_revision',
      'approval_hold_minutes',s.snapshot->'approval_hold_minutes','payment_hold_minutes',s.snapshot->'payment_hold_minutes',
      'refund_cutoff_hours',s.snapshot->'refund_cutoff_hours'),
      case when hold is null then 'confirmed' else 'pending' end,hold)
    returning id into booking_id;
  update private.open_play_sessions x set reserved_spots=x.reserved_spots+spots where x.id=s.id;
  insert into private.session_booking_events(booking_id,actor_user_id,action) values(booking_id,actor_user_id,'request');
  return jsonb_build_object('outcome','created','booking',private.session_booking_json(booking_id,at_time));
end; $$;

-- Owners accept/decline pending groups; the booking player cancels. Occupied-session cancellation is T31.
create function public.session_booking_change(actor_user_id uuid,target_booking_id uuid,command text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b private.session_bookings; s private.open_play_sessions; listing public.venues; at_time timestamptz; next_status text;
begin
  if actor_user_id is null or command is null or command not in ('accept','decline','cancel')
    or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Invalid command' using errcode='22023',hint='invalid_input';
  end if;
  select x.* into b from private.session_bookings x where x.id=target_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
  select x.* into s from private.open_play_sessions x where x.id=b.session_id;
  select v.* into listing from public.venues v where v.id=s.venue_id for share;
  if command in ('accept','decline') then perform private.rental_require_owner(actor_user_id,s.venue_id);
  elsif b.requested_by<>actor_user_id then raise exception 'Player required' using errcode='42501',hint='not_player';
  end if;
  select x.* into s from private.open_play_sessions x where x.id=b.session_id for update;
  select x.* into b from private.session_bookings x where x.id=target_booking_id for update;
  at_time:=clock_timestamp();
  -- Never accept or cancel an elapsed hold, even if no earlier write released it.
  if b.status='pending' and b.expires_at<=at_time then
    perform private.session_expire_holds(s.id,at_time);
    return jsonb_build_object('outcome','expired','booking',private.session_booking_json(b.id,clock_timestamp()));
  end if;
  perform private.session_expire_holds(s.id,at_time);
  next_status:=case command when 'accept' then 'confirmed' when 'decline' then 'declined' else 'cancelled' end;
  if b.status=next_status then return jsonb_build_object('outcome','existing','booking',private.session_booking_json(b.id,at_time)); end if;
  if (command in ('accept','decline') and b.status<>'pending') or (command='cancel' and b.status not in ('pending','confirmed'))
    or s.starts_at<=at_time or s.status<>'scheduled' then
    raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
  end if;
  if command='accept' then
    if listing.publication_status<>'approved' or listing.claim_status<>'verified' then
      raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
    end if;
    update private.session_bookings x set status='confirmed',expires_at=null,updated_at=clock_timestamp() where x.id=b.id;
  else
    update private.session_bookings x set status=next_status,updated_at=clock_timestamp() where x.id=b.id;
    update private.open_play_sessions x set reserved_spots=x.reserved_spots-b.spots where x.id=s.id;
  end if;
  insert into private.session_booking_events(booking_id,actor_user_id,action) values(b.id,actor_user_id,command);
  return jsonb_build_object('outcome','changed','booking',private.session_booking_json(b.id,clock_timestamp()));
end; $$;

-- Read-only: effective expiry is computed, never written. UUID pages of 25, except upcoming sessions by start time.
create function public.session_booking_read(actor_user_id uuid,section text,target_id uuid default null,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); listing public.venues; b private.session_bookings; cursor_start timestamptz; ids uuid[];
begin
  if actor_user_id is null or section is null or not exists(select 1 from auth.users u where u.id=actor_user_id)
    or section not in ('sessions','session','booking','history','requests')
    or (section='history')<>(target_id is null) or (section in ('session','booking') and after_id is not null) then
    raise exception 'Invalid read' using errcode='22023',hint='invalid_input';
  end if;
  if section in ('sessions','session') then
    if section='session' then
      select v.* into listing from public.venues v join private.open_play_sessions x on x.venue_id=v.id where x.id=target_id;
      if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
    else
      select v.* into listing from public.venues v where v.id=target_id;
    end if;
    if listing.id is null or not private.session_venue_bookable(listing) then
      raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
    end if;
    if section='session' then return jsonb_build_object('at',at_time,'session',private.session_offer_json(target_id,at_time)); end if;
    if after_id is not null then
      select x.starts_at into cursor_start from private.open_play_sessions x where x.id=after_id and x.venue_id=target_id;
      if not found then raise exception 'Invalid cursor' using errcode='22023',hint='invalid_input'; end if;
    end if;
    select array_agg(p.id order by p.starts_at,p.id) into ids from (select x.id,x.starts_at from private.open_play_sessions x
      where x.venue_id=target_id and x.status='scheduled' and x.starts_at>at_time
        and (after_id is null or (x.starts_at,x.id)>(cursor_start,after_id)) order by x.starts_at,x.id limit 26) p;
    return jsonb_build_object('venue_id',target_id,'at',at_time,'sessions',coalesce((select jsonb_agg(private.session_offer_json(i,at_time) order by n)
      from unnest(ids[1:25]) with ordinality u(i,n)),'[]'::jsonb),'next_cursor',case when cardinality(ids)>25 then ids[25] end);
  end if;
  if section='booking' then
    select x.* into b from private.session_bookings x where x.id=target_id;
    if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
    if b.requested_by<>actor_user_id then
      perform 1 from public.venues v join private.open_play_sessions x on x.venue_id=v.id where x.id=b.session_id for share of v;
      perform private.rental_require_owner(actor_user_id,(select x.venue_id from private.open_play_sessions x where x.id=b.session_id));
    end if;
    return jsonb_build_object('booking',private.session_booking_json(target_id,at_time));
  end if;
  if section='requests' then
    perform 1 from public.venues v where v.id=target_id for share;
    perform private.rental_require_owner(actor_user_id,target_id);
  end if;
  select array_agg(p.id order by p.id) into ids from (select x.id from private.session_bookings x
    where (case when section='history' then x.requested_by=actor_user_id
      else x.status='pending' and x.expires_at>at_time and x.session_id in (select o.id from private.open_play_sessions o where o.venue_id=target_id) end)
      and (after_id is null or x.id>after_id) order by x.id limit 26) p;
  return jsonb_build_object('bookings',coalesce((select jsonb_agg(private.session_booking_json(i,at_time) order by i)
    from unnest(ids[1:25]) i),'[]'::jsonb),'next_cursor',case when cardinality(ids)>25 then ids[25] end);
end; $$;

-- Elapsed holds release on access before the T27 empty-session check.
create or replace function public.owner_session_cancel(actor_user_id uuid,target_session_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved private.open_play_sessions; allocation uuid;
begin
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  perform 1 from public.venues v where v.id=saved.venue_id for share;
  perform private.rental_require_owner(actor_user_id,saved.venue_id);
  perform 1 from public.courts c join private.session_courts sc on sc.court_id=c.id
    where sc.session_id=saved.id order by c.id for no key update of c;
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id for update;
  if saved.status='cancelled' then return jsonb_build_object('outcome','existing','session',private.session_json(saved.id,clock_timestamp())); end if;
  perform private.session_expire_holds(saved.id,clock_timestamp());
  select s.* into saved from private.open_play_sessions s where s.id=target_session_id;
  if saved.reserved_spots>0 then raise exception 'Session has bookings' using errcode='55000',hint='session_has_bookings'; end if;
  if saved.starts_at<=clock_timestamp() then raise exception 'Session already started' using errcode='55000',hint='session_started'; end if;
  for allocation in select sc.allocation_id from private.session_courts sc where sc.session_id=saved.id order by sc.court_id loop
    perform private.allocation_release(allocation);
  end loop;
  update private.open_play_sessions set status='cancelled',cancelled_at=clock_timestamp() where id=saved.id;
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action) values(actor_user_id,saved.venue_id,'session.cancel');
  return jsonb_build_object('outcome','cancelled','session',private.session_json(saved.id,clock_timestamp()));
end; $$;

revoke all on function private.session_booking_guard(),private.session_reserved(uuid,integer,timestamptz),
  private.session_expire_holds(uuid,timestamptz),private.session_offer_json(uuid,timestamptz),
  private.session_booking_json(uuid,timestamptz),private.session_venue_bookable(public.venues) from public,anon,authenticated,service_role;
revoke all on function public.session_booking_request(uuid,jsonb),public.session_booking_change(uuid,uuid,text),
  public.session_booking_read(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.session_booking_request(uuid,jsonb),public.session_booking_change(uuid,uuid,text),
  public.session_booking_read(uuid,text,uuid,uuid) to service_role;
notify pgrst,'reload schema';
