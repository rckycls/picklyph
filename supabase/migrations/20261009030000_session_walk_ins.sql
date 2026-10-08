-- T29: owners enter named arrival walk-ins against the same locked session spot inventory as player groups.
alter table private.session_bookings add column source text not null default 'player' check (source in ('player','walk_in'));
-- Walk-ins are confirmed on entry and never hold spots pending approval.
alter table private.session_bookings add constraint session_bookings_walk_in_confirmed
  check (source='player' or (status in ('confirmed','cancelled') and expires_at is null));
-- One live group per player per session; an owner may enter any number of walk-in groups.
drop index private.session_bookings_one_live;
create unique index session_bookings_one_live on private.session_bookings(session_id,requested_by)
  where status in ('pending','confirmed') and source='player';
create index session_bookings_walk_ins on private.session_bookings(session_id,id) where source='walk_in';
alter table private.session_booking_events drop constraint session_booking_events_action_check;
alter table private.session_booking_events add constraint session_booking_events_action_check
  check (action in ('request','accept','decline','cancel','expire','walk_in'));

create or replace function private.session_booking_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.session_id,new.requested_by,new.request_id,new.request_input,new.participants,new.spots,new.snapshot,new.created_at,new.source)
    is distinct from (old.id,old.session_id,old.requested_by,old.request_id,old.request_input,old.participants,old.spots,old.snapshot,old.created_at,old.source)
    or (new.status<>old.status and not (old.status='pending' or (old.status='confirmed' and new.status='cancelled')))
    or (new.status=old.status and new.expires_at is distinct from old.expires_at) then
    raise exception 'Session booking is immutable' using errcode='55000',hint='immutable_booking';
  end if;
  return new;
end; $$;

-- Shared group input: exact keys, UUIDs, safe integer total, trimmed names of 1–60 characters, unique ignoring case.
create function private.session_group_input(raw jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare target uuid; request uuid; expected numeric; names jsonb;
begin
  if jsonb_typeof(raw) is distinct from 'object'
    or not raw ?& array['session_id','request_id','participants','expected_total_centavos']
    or (select count(*) from jsonb_object_keys(raw))<>4
    or jsonb_typeof(raw->'session_id') is distinct from 'string'
    or jsonb_typeof(raw->'request_id') is distinct from 'string'
    or jsonb_typeof(raw->'expected_total_centavos') is distinct from 'number'
    or jsonb_typeof(raw->'participants') is distinct from 'array'
    or jsonb_array_length(raw->'participants') not between 1 and 200
    or exists(select 1 from jsonb_array_elements(raw->'participants') x where jsonb_typeof(x)<>'string') then
    raise exception 'Invalid booking' using errcode='22023',hint='invalid_input';
  end if;
  begin
    target:=(raw->>'session_id')::uuid; request:=(raw->>'request_id')::uuid; expected:=(raw->>'expected_total_centavos')::numeric;
  exception when others then raise exception 'Invalid booking' using errcode='22023',hint='invalid_input'; end;
  select jsonb_agg(btrim(p.x) order by p.n) into names from jsonb_array_elements_text(raw->'participants') with ordinality p(x,n);
  if target is null or request is null or expected<0 or expected<>trunc(expected) or expected>9007199254740991
    or exists(select 1 from jsonb_array_elements_text(names) x where char_length(x) not between 1 and 60 or x~'[[:cntrl:]]')
    or (select count(distinct lower(x)) from jsonb_array_elements_text(names) x)<>jsonb_array_length(names) then
    raise exception 'Invalid booking' using errcode='22023',hint='invalid_input';
  end if;
  return jsonb_build_object('session_id',target,'request_id',request,'participants',names,'expected_total_centavos',expected);
end; $$;

-- Group snapshot from the immutable session snapshot; never the venue's current policy or schedule.
create function private.session_group_snapshot(s private.open_play_sessions,spots integer,total numeric) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('venue_id',s.venue_id,
    'title',s.snapshot->'title','court_ids',s.snapshot->'court_ids','starts_at',s.snapshot->'starts_at','ends_at',s.snapshot->'ends_at',
    'price_centavos',s.snapshot->'price_centavos','spots',spots,'total_centavos',total,'currency','PHP','timezone','Asia/Manila',
    'policy',s.snapshot->'policy','policy_revision',s.snapshot->'policy_revision',
    'approval_hold_minutes',s.snapshot->'approval_hold_minutes','payment_hold_minutes',s.snapshot->'payment_hold_minutes',
    'refund_cutoff_hours',s.snapshot->'refund_cutoff_hours');
$$;

create or replace function private.session_booking_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'session_id',b.session_id,'source',b.source,
    'status',case when b.status='pending' and b.expires_at<=at_time then 'expired' else b.status end,
    'payment_method','arrival','payment_status','unpaid','participants',b.participants,'spots',b.spots,
    'expires_at',b.expires_at,'created_at',b.created_at,
    'updated_at',case when b.status='pending' and b.expires_at<=at_time then b.expires_at else b.updated_at end,
    'snapshot',b.snapshot)
  from private.session_bookings b where b.id=target_id;
$$;

-- T28 request, now sharing input/snapshot helpers; walk-ins an owner entered never count as their own player group.
create or replace function public.session_booking_request(actor_user_id uuid,booking_input jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare target uuid; request uuid; canonical jsonb; existing private.session_bookings;
  s private.open_play_sessions; listing public.venues; at_time timestamptz; spots integer; total numeric;
  hold timestamptz; booking_id uuid;
begin
  if actor_user_id is null or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Player required' using errcode='42501',hint='player_required';
  end if;
  canonical:=private.session_group_input(booking_input);
  target:=(canonical->>'session_id')::uuid; request:=(canonical->>'request_id')::uuid;
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
  spots:=jsonb_array_length(canonical->'participants');
  if spots>(s.snapshot->>'group_limit')::integer then
    raise exception 'Group too large' using errcode='23514',hint='group_limit_exceeded';
  end if;
  total:=(s.snapshot->>'price_centavos')::numeric*spots;
  if (canonical->>'expected_total_centavos')::numeric<>total then raise exception 'Review changed total' using errcode='40001',hint='stale_quote'; end if;
  if exists(select 1 from private.session_bookings b where b.session_id=s.id and b.requested_by=actor_user_id
    and b.source='player' and b.status in ('pending','confirmed')) then
    raise exception 'Already booked' using errcode='23505',hint='already_booked';
  end if;
  if s.reserved_spots+spots>s.capacity then raise exception 'Session full' using errcode='23514',hint='session_full'; end if;
  if s.snapshot->'policy'->>'confirmation'='approval' then
    hold:=least(at_time+make_interval(mins=>(s.snapshot->>'approval_hold_minutes')::integer),s.starts_at);
  end if;
  insert into private.session_bookings(session_id,requested_by,request_id,request_input,participants,spots,snapshot,status,expires_at)
    values(s.id,actor_user_id,request,canonical,canonical->'participants',spots,private.session_group_snapshot(s,spots,total),
      case when hold is null then 'confirmed' else 'pending' end,hold)
    returning id into booking_id;
  update private.open_play_sessions x set reserved_spots=x.reserved_spots+spots where x.id=s.id;
  insert into private.session_booking_events(booking_id,actor_user_id,action) values(booking_id,actor_user_id,'request');
  return jsonb_build_object('outcome','created','booking',private.session_booking_json(booking_id,at_time));
end; $$;

-- Current owners enter confirmed arrival walk-ins until the session ends. Same lock order and counter as player groups.
create function public.session_walk_in(actor_user_id uuid,walk_in_input jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare target uuid; request uuid; canonical jsonb; existing private.session_bookings;
  s private.open_play_sessions; listing public.venues; at_time timestamptz; spots integer; total numeric; booking_id uuid;
begin
  if actor_user_id is null or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Owner required' using errcode='42501',hint='not_owner';
  end if;
  -- The kind keeps one retry key from ever naming both a player group and a walk-in.
  canonical:=private.session_group_input(walk_in_input)||jsonb_build_object('kind','walk_in');
  target:=(canonical->>'session_id')::uuid; request:=(canonical->>'request_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('session-booking:'||actor_user_id::text||':'||request::text,0));
  select b.* into existing from private.session_bookings b where b.requested_by=actor_user_id and b.request_id=request;
  if found then
    if existing.request_input<>canonical then raise exception 'Request already used' using errcode='23505',hint='request_reused'; end if;
    select x.* into s from private.open_play_sessions x where x.id=existing.session_id;
    perform 1 from public.venues v where v.id=s.venue_id for share;
    -- A revoked owner cannot replay a key to read the walk-in names.
    perform private.rental_require_owner(actor_user_id,s.venue_id);
    perform 1 from private.open_play_sessions x where x.id=s.id for share;
    return jsonb_build_object('outcome','existing','booking',private.session_booking_json(existing.id,clock_timestamp()));
  end if;
  select x.* into s from private.open_play_sessions x where x.id=target;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  select v.* into listing from public.venues v where v.id=s.venue_id for share;
  perform private.rental_require_owner(actor_user_id,s.venue_id);
  select x.* into s from private.open_play_sessions x where x.id=target for update;
  if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
  at_time:=clock_timestamp();
  perform private.session_expire_holds(s.id,at_time);
  select x.* into s from private.open_play_sessions x where x.id=target;
  if not private.session_venue_bookable(listing) then
    raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
  end if;
  if s.status<>'scheduled' then raise exception 'Session cancelled' using errcode='55000',hint='session_cancelled'; end if;
  if s.ends_at<=at_time then raise exception 'Session ended' using errcode='55000',hint='session_ended'; end if;
  spots:=jsonb_array_length(canonical->'participants');
  if spots>(s.snapshot->>'group_limit')::integer then
    raise exception 'Group too large' using errcode='23514',hint='group_limit_exceeded';
  end if;
  total:=(s.snapshot->>'price_centavos')::numeric*spots;
  if (canonical->>'expected_total_centavos')::numeric<>total then raise exception 'Review changed total' using errcode='40001',hint='stale_quote'; end if;
  if s.reserved_spots+spots>s.capacity then raise exception 'Session full' using errcode='23514',hint='session_full'; end if;
  insert into private.session_bookings(session_id,requested_by,request_id,request_input,participants,spots,snapshot,status,source)
    values(s.id,actor_user_id,request,canonical,canonical->'participants',spots,private.session_group_snapshot(s,spots,total),'confirmed','walk_in')
    returning id into booking_id;
  update private.open_play_sessions x set reserved_spots=x.reserved_spots+spots where x.id=s.id;
  insert into private.session_booking_events(booking_id,actor_user_id,action) values(booking_id,actor_user_id,'walk_in');
  return jsonb_build_object('outcome','created','booking',private.session_booking_json(booking_id,at_time));
end; $$;

-- Owners accept/decline pending player groups; the booking player cancels. Any current owner removes a walk-in until the session ends.
create or replace function public.session_booking_change(actor_user_id uuid,target_booking_id uuid,command text) returns jsonb
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
  if command in ('accept','decline') or b.source='walk_in' then perform private.rental_require_owner(actor_user_id,s.venue_id);
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
    or (case when b.source='walk_in' then s.ends_at else s.starts_at end)<=at_time or s.status<>'scheduled' then
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
-- Walk-in names are the venue's roster: only current owners read them, including the owner who entered them.
create or replace function public.session_booking_read(actor_user_id uuid,section text,target_id uuid default null,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); listing public.venues; b private.session_bookings; cursor_start timestamptz; ids uuid[]; venue uuid;
begin
  if actor_user_id is null or section is null or not exists(select 1 from auth.users u where u.id=actor_user_id)
    or section not in ('sessions','session','booking','history','requests','walk_ins')
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
    if b.source='walk_in' or b.requested_by<>actor_user_id then
      perform 1 from public.venues v join private.open_play_sessions x on x.venue_id=v.id where x.id=b.session_id for share of v;
      perform private.rental_require_owner(actor_user_id,(select x.venue_id from private.open_play_sessions x where x.id=b.session_id));
    end if;
    return jsonb_build_object('booking',private.session_booking_json(target_id,at_time));
  end if;
  if section='requests' then
    perform 1 from public.venues v where v.id=target_id for share;
    perform private.rental_require_owner(actor_user_id,target_id);
  elsif section='walk_ins' then
    select x.venue_id into venue from private.open_play_sessions x where x.id=target_id;
    if not found then raise exception 'Session unavailable' using errcode='P0002',hint='session_not_found'; end if;
    perform 1 from public.venues v where v.id=venue for share;
    perform private.rental_require_owner(actor_user_id,venue);
  end if;
  select array_agg(p.id order by p.id) into ids from (select x.id from private.session_bookings x
    where (case section when 'history' then x.requested_by=actor_user_id and x.source='player'
      when 'walk_ins' then x.session_id=target_id and x.source='walk_in'
      else x.status='pending' and x.expires_at>at_time and x.session_id in (select o.id from private.open_play_sessions o where o.venue_id=target_id) end)
      and (after_id is null or x.id>after_id) order by x.id limit 26) p;
  return jsonb_build_object('bookings',coalesce((select jsonb_agg(private.session_booking_json(i,at_time) order by i)
    from unnest(ids[1:25]) i),'[]'::jsonb),'next_cursor',case when cardinality(ids)>25 then ids[25] end);
end; $$;

revoke all on function private.session_group_input(jsonb),private.session_group_snapshot(private.open_play_sessions,integer,numeric),
  private.session_booking_guard(),private.session_booking_json(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.session_walk_in(uuid,jsonb),public.session_booking_request(uuid,jsonb),
  public.session_booking_change(uuid,uuid,text),public.session_booking_read(uuid,text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.session_walk_in(uuid,jsonb),public.session_booking_request(uuid,jsonb),
  public.session_booking_change(uuid,uuid,text),public.session_booking_read(uuid,text,uuid,uuid) to service_role;
notify pgrst,'reload schema';
