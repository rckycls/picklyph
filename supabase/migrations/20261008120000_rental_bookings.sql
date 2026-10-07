-- T24: arrival rental lifecycle. Only guarded, verified server commands execute.
create table private.rental_bookings (
  id uuid primary key references private.court_allocations(id) on delete cascade,
  status text not null check (status in ('pending','confirmed','declined','cancelled','expired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table private.rental_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references private.rental_bookings(id) on delete cascade,
  actor_user_id uuid not null,
  action text not null check (action in ('request','accept','decline','cancel','expire')),
  created_at timestamptz not null default clock_timestamp()
);
create index rental_events_booking on private.rental_events(booking_id,id);
create index court_allocations_player_history on private.court_allocations(requested_by,id) where kind='rental';
alter table private.rental_bookings enable row level security;
alter table private.rental_events enable row level security;
revoke all on private.rental_bookings, private.rental_events from public,anon,authenticated,service_role;
revoke all on sequence private.rental_events_id_seq from public,anon,authenticated,service_role;
create trigger rental_events_immutable before update on private.rental_events
  for each row execute function private.rental_snapshot_immutable();

create function private.rental_booking_json(target_id uuid, at_time timestamptz) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'status',case when b.status='pending'
      and (a.state='expired' or a.expires_at<=at_time) then 'expired' else b.status end,
    'payment_method','arrival','payment_status','unpaid','created_at',b.created_at,'updated_at',
    case when b.status='pending' and (a.state='expired' or a.expires_at<=at_time) then a.expires_at else b.updated_at end,
    'allocation',private.allocation_json(a,at_time),'snapshot',s.snapshot)
  from private.rental_bookings b join private.court_allocations a on a.id=b.id
    join private.rental_snapshots s on s.allocation_id=b.id where b.id=target_id;
$$;

-- Called after the venue lock, including for suspended-venue release/read.
create function private.rental_require_owner(actor uuid, venue uuid) returns void
language plpgsql set search_path='' as $$
begin
  perform 1 from private.venue_owners o join public.venues v on v.id=o.venue_id
    where o.venue_id=venue and o.user_id=actor and v.claim_status='verified' for share of o;
  if not found then raise exception 'Owner required' using errcode='42501',hint='not_owner'; end if;
end;
$$;

-- No inventory promise: quote and request each resolve current rules under locks.
create function private.rental_quote(target_court_id uuid, starts timestamptz, ends timestamptz) returns jsonb
language plpgsql set search_path='' as $$
declare court public.courts; listing public.venues; policy jsonb; price jsonb;
  revision text; court_revision text; first_date date; last_date date; at_time timestamptz;
begin
  select c.* into court from public.courts c where c.id=target_court_id;
  if not found then raise exception 'Court unavailable' using errcode='P0002',hint='court_unavailable'; end if;
  select v.* into listing from public.venues v where v.id=court.venue_id for share;
  select c.* into court from public.courts c where c.id=target_court_id for no key update;
  if not found or court.status<>'active' then raise exception 'Court unavailable' using errcode='P0002',hint='court_unavailable'; end if;
  if listing.publication_status<>'approved' or listing.claim_status<>'verified'
    or not exists(select 1 from private.venue_owners o where o.venue_id=court.venue_id) then
    raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
  end if;
  perform 1 from private.venue_merchants m where m.venue_id=court.venue_id for share;
  at_time:=clock_timestamp();
  perform private.validate_rental_window(starts,ends,at_time);
  policy:=private.venue_policy_view(court.venue_id);
  if policy->>'payment'='online' then raise exception 'Arrival unavailable' using errcode='23514',hint='arrival_unavailable'; end if;
  select s.revision::text into revision from private.venue_schedules s where s.venue_id=court.venue_id;
  select s.revision::text into court_revision from private.court_schedules s where s.court_id=court.id;
  first_date:=(starts at time zone 'Asia/Manila')::date;
  last_date:=((ends-interval '1 microsecond') at time zone 'Asia/Manila')::date;
  price:=private.rental_price(starts,ends,private.resolve_court_hours(court.id,first_date,last_date-first_date+1));
  return price || jsonb_build_object('court_id',court.id,'venue_id',court.venue_id,'starts_at',starts,'ends_at',ends,
    'quoted_at',at_time,'policy',policy-'venue_id'-'revision','expected_quote',jsonb_build_object(
      'total_centavos',price->'total_centavos','schedule_revision',revision,'court_hours_revision',court_revision,
      'policy_revision',policy->>'revision'));
end;
$$;

create function public.rental_booking_quote(actor_user_id uuid,target_court_id uuid,starts timestamptz,ends timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if actor_user_id is null or not exists(select 1 from auth.users where id=actor_user_id) then
    raise exception 'Player required' using errcode='42501',hint='player_required';
  end if;
  return private.rental_quote(target_court_id,starts,ends);
end;
$$;

create function public.rental_booking_request(actor_user_id uuid,target_court_id uuid,request_id uuid,
  starts timestamptz,ends timestamptz,expected_quote jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare existing private.court_allocations; quote jsonb; acquired jsonb; booking_id uuid; hold_until timestamptz; at_time timestamptz;
begin
  if actor_user_id is null or request_id is null or target_court_id is null or starts is null or ends is null
    or not exists(select 1 from auth.users where id=actor_user_id) then
    raise exception 'Player/input required' using errcode='22023',hint='invalid_input';
  end if;
  -- Serialize a player's retry key even when competing attempts name different courts.
  perform pg_advisory_xact_lock(hashtextextended(actor_user_id::text||':'||request_id::text,24));
  select a.* into existing from private.court_allocations a where a.requested_by=actor_user_id and a.request_id=rental_booking_request.request_id;
  if found then
    if existing.kind<>'rental' or existing.court_id<>target_court_id or existing.starts_at<>starts or existing.ends_at<>ends
      or not exists(select 1 from private.rental_bookings b where b.id=existing.id) then
      raise exception 'Request reused' using errcode='23505',hint='request_reused';
    end if;
    -- Return a single consistent read after a concurrent lifecycle command commits.
    perform 1 from public.venues v where v.id=existing.venue_id for share;
    perform 1 from public.courts c where c.id=existing.court_id for no key update;
    return jsonb_build_object('outcome','existing','booking',private.rental_booking_json(existing.id,clock_timestamp()));
  end if;
  quote:=private.rental_quote(target_court_id,starts,ends);
  if expected_quote is distinct from quote->'expected_quote' then
    raise exception 'Review changed price/policy' using errcode='40001',hint='stale_quote';
  end if;
  at_time:=clock_timestamp();
  if quote->'policy'->>'confirmation'='approval' then hold_until:=least(at_time+interval '2 hours',starts); end if;
  acquired:=private.rental_acquire(actor_user_id,target_court_id,starts,ends,hold_until,request_id);
  booking_id:=(acquired->'allocation'->>'id')::uuid;
  insert into private.rental_bookings(id,status) values(booking_id,case when hold_until is null then 'confirmed' else 'pending' end);
  insert into private.rental_events(booking_id,actor_user_id,action) values(booking_id,actor_user_id,'request');
  return jsonb_build_object('outcome','created','booking',private.rental_booking_json(booking_id,clock_timestamp()));
end;
$$;

create function public.rental_booking_change(actor_user_id uuid,target_booking_id uuid,command text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; b private.rental_bookings; at_time timestamptz; next_status text; result jsonb; listing public.venues;
begin
  if actor_user_id is null or command is null or command not in ('accept','decline','cancel','expire')
    or not exists(select 1 from auth.users where id=actor_user_id) then
    raise exception 'Invalid command' using errcode='22023',hint='invalid_input';
  end if;
  select x.* into a from private.court_allocations x join private.rental_bookings y on y.id=x.id where x.id=target_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
  select v.* into listing from public.venues v where v.id=a.venue_id for share;
  if command in ('accept','decline') or (command='expire' and a.requested_by<>actor_user_id) then
    perform private.rental_require_owner(actor_user_id,a.venue_id);
  elsif a.requested_by<>actor_user_id then
    raise exception 'Player required' using errcode='42501',hint='not_player';
  end if;
  perform 1 from public.courts c where c.id=a.court_id for no key update;
  select x.* into a from private.court_allocations x where x.id=target_booking_id for update;
  select x.* into b from private.rental_bookings x where x.id=target_booking_id for update;
  at_time:=clock_timestamp();
  -- Acceptance never revives an elapsed hold, even if no sweep has run.
  if b.status='pending' and (a.state='expired' or a.expires_at<=at_time) then
    perform private.allocation_release(a.id);
    update private.rental_bookings set status='expired',updated_at=a.expires_at where id=b.id;
    insert into private.rental_events(booking_id,actor_user_id,action) values(b.id,actor_user_id,'expire');
    return jsonb_build_object('outcome','expired','booking',private.rental_booking_json(b.id,clock_timestamp()));
  end if;
  next_status:=case command when 'accept' then 'confirmed' when 'decline' then 'declined' when 'cancel' then 'cancelled' else b.status end;
  if command='expire' or b.status=next_status then
    return jsonb_build_object('outcome','existing','booking',private.rental_booking_json(b.id,at_time));
  end if;
  if (command in ('accept','decline') and b.status<>'pending') or (command='cancel' and b.status not in ('pending','confirmed'))
    or a.starts_at<=at_time or not private.allocation_live(a.state,a.expires_at,at_time) then
    raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
  end if;
  if command='accept' then
    if listing.publication_status<>'approved' or listing.claim_status<>'verified' then
      raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
    end if;
    result:=private.allocation_renew(a.id,null);
    if result->'allocation'->>'state'<>'active' then raise exception 'Allocation ended' using errcode='23514',hint='allocation_ended'; end if;
  else
    result:=private.allocation_release(a.id);
    -- Account for expiry crossing the release helper's authoritative clock.
    if result->'allocation'->>'state'='expired' then next_status:='expired'; command:='expire'; end if;
  end if;
  update private.rental_bookings set status=next_status,updated_at=clock_timestamp() where id=b.id;
  insert into private.rental_events(booking_id,actor_user_id,action) values(b.id,actor_user_id,command);
  return jsonb_build_object('outcome','changed','booking',private.rental_booking_json(b.id,clock_timestamp()));
end;
$$;

create function public.rental_booking_read(actor_user_id uuid,target_booking_id uuid default null,
  target_venue_id uuid default null,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; rows jsonb; cursor uuid; at_time timestamptz;
begin
  if actor_user_id is null or not exists(select 1 from auth.users where id=actor_user_id)
    or (target_booking_id is not null and (target_venue_id is not null or after_id is not null)) then
    raise exception 'Invalid read' using errcode='22023',hint='invalid_input';
  end if;
  if target_booking_id is not null then
    select x.* into a from private.court_allocations x join private.rental_bookings b on b.id=x.id where x.id=target_booking_id;
    if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
    if a.requested_by<>actor_user_id then
      perform 1 from public.venues v where v.id=a.venue_id for share;
      perform private.rental_require_owner(actor_user_id,a.venue_id);
    end if;
    return jsonb_build_object('booking',private.rental_booking_json(target_booking_id,clock_timestamp()));
  end if;
  if target_venue_id is not null then
    perform 1 from public.venues v where v.id=target_venue_id for share;
    perform private.rental_require_owner(actor_user_id,target_venue_id);
  end if;
  at_time:=clock_timestamp();
  with page as (
    select ca.id from private.court_allocations ca join private.rental_bookings bk on bk.id=ca.id
    where (case when target_venue_id is null then ca.requested_by=actor_user_id else ca.venue_id=target_venue_id
      and bk.status='pending' and private.allocation_live(ca.state,ca.expires_at,at_time) end)
      and (after_id is null or ca.id>after_id) order by ca.id limit 26
  ), numbered as (select id,row_number() over(order by id) n from page)
  select coalesce(jsonb_agg(private.rental_booking_json(id,at_time) order by id) filter(where n<=25),'[]'::jsonb),
    case when count(*)>25 then (array_agg(id order by id))[25] end into rows,cursor from numbered;
  return jsonb_build_object('bookings',rows,'next_cursor',cursor);
end;
$$;

revoke all on function private.rental_booking_json(uuid,timestamptz),private.rental_require_owner(uuid,uuid),
  private.rental_quote(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.rental_booking_quote(uuid,uuid,timestamptz,timestamptz),
  public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb),
  public.rental_booking_change(uuid,uuid,text),public.rental_booking_read(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.rental_booking_quote(uuid,uuid,timestamptz,timestamptz),
  public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb),
  public.rental_booking_change(uuid,uuid,text),public.rental_booking_read(uuid,uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
