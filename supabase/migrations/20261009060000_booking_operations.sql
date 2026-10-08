-- T31: owner-entered outside rentals, attendance and arrival-payment records.
-- Attendance and payments sit beside bookings: they never change booking status, snapshots or inventory.

-- Outside rentals an owner records (phone, chat, counter) are rentals in the same inventory, confirmed on entry.
alter table private.rental_bookings
  add column source text not null default 'player' check (source in ('player','owner')),
  add column guest_name text,
  add constraint rental_bookings_owner_guest check ((source='owner')=(guest_name is not null) and (guest_name is null
    or (guest_name=btrim(guest_name) and char_length(guest_name) between 1 and 60 and guest_name!~'[[:cntrl:]]'))),
  add constraint rental_bookings_owner_confirmed check (source='player' or status in ('confirmed','cancelled'));
create function private.rental_booking_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.source,new.guest_name,new.created_at) is distinct from (old.id,old.source,old.guest_name,old.created_at) then
    raise exception 'Rental booking is immutable' using errcode='55000',hint='immutable_booking';
  end if;
  return new;
end; $$;
create trigger rental_booking_guard before update on private.rental_bookings for each row execute function private.rental_booking_guard();

alter table private.rental_events drop constraint rental_events_action_check;
alter table private.rental_events add constraint rental_events_action_check
  check (action in ('request','accept','decline','cancel','expire','owner_entry','check_in','no_show','complete','payment'));
alter table private.session_booking_events drop constraint session_booking_events_action_check;
alter table private.session_booking_events add constraint session_booking_events_action_check
  check (action in ('request','accept','decline','cancel','expire','walk_in','check_in','no_show','complete','payment'));

-- One row per rental or group, created by its first attendance or payment record.
create table private.booking_operations (
  booking_id uuid primary key,
  rental_booking_id uuid unique references private.rental_bookings(id) on delete cascade,
  session_booking_id uuid unique references private.session_bookings(id) on delete cascade,
  attendance text not null default 'none' check (attendance in ('none','checked_in','no_show','completed')),
  attendance_at timestamptz,
  payment_method text check (payment_method in ('cash','ewallet','card','bank_transfer','other')),
  paid_centavos bigint check (paid_centavos between 0 and 9007199254740991),
  paid_at timestamptz,
  check (num_nonnulls(rental_booking_id,session_booking_id)=1 and booking_id=coalesce(rental_booking_id,session_booking_id)),
  check ((attendance='none')=(attendance_at is null)),
  check (num_nulls(payment_method,paid_centavos,paid_at) in (0,3))
);
alter table private.booking_operations enable row level security;
revoke all on private.booking_operations from public,anon,authenticated,service_role;
create function private.booking_operations_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.booking_id,new.rental_booking_id,new.session_booking_id) is distinct from (old.booking_id,old.rental_booking_id,old.session_booking_id)
    or (new.attendance<>old.attendance and not ((old.attendance='none' and new.attendance in ('checked_in','no_show'))
      or (old.attendance='checked_in' and new.attendance='completed')))
    or (new.attendance=old.attendance and new.attendance_at is distinct from old.attendance_at)
    or (old.paid_at is not null and (new.payment_method,new.paid_centavos,new.paid_at) is distinct from (old.payment_method,old.paid_centavos,old.paid_at)) then
    raise exception 'Booking operation is immutable' using errcode='55000',hint='immutable_operation';
  end if;
  return new;
end; $$;
create trigger booking_operations_guard before update on private.booking_operations for each row execute function private.booking_operations_guard();

create function private.booking_operations_json(target_id uuid) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('attendance',coalesce(o.attendance,'none'),'attendance_at',o.attendance_at,
    'payment',case when o.paid_at is null then null else jsonb_build_object('method',o.payment_method,
      'amount_centavos',o.paid_centavos,'recorded_at',o.paid_at) end)
  from (select 1) x left join private.booking_operations o on o.booking_id=target_id;
$$;

-- Booking reads gain source, the owner's guest label, the recorded arrival payment and attendance. Owner entries are owner-only reads.
create or replace function private.rental_booking_json(target_id uuid, at_time timestamptz) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'source',b.source,'guest_name',b.guest_name,'status',case when b.status='pending'
      and (a.state='expired' or a.expires_at<=at_time) then 'expired' else b.status end,
    'payment_method','arrival','payment_status',case when o.paid_at is null then 'unpaid' else 'paid' end,'created_at',b.created_at,'updated_at',
    case when b.status='pending' and (a.state='expired' or a.expires_at<=at_time) then a.expires_at else b.updated_at end,
    'allocation',private.allocation_json(a,at_time),'snapshot',s.snapshot,'operations',private.booking_operations_json(b.id))
  from private.rental_bookings b join private.court_allocations a on a.id=b.id
    join private.rental_snapshots s on s.allocation_id=b.id left join private.booking_operations o on o.booking_id=b.id where b.id=target_id;
$$;
create or replace function private.session_booking_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',b.id,'session_id',b.session_id,'source',b.source,
    'status',case when b.status='pending' and b.expires_at<=at_time then 'expired' else b.status end,
    'payment_method','arrival','payment_status',case when o.paid_at is null then 'unpaid' else 'paid' end,
    'participants',b.participants,'spots',b.spots,'expires_at',b.expires_at,'created_at',b.created_at,
    'updated_at',case when b.status='pending' and b.expires_at<=at_time then b.expires_at else b.updated_at end,
    'snapshot',b.snapshot,'operations',private.booking_operations_json(b.id))
  from private.session_bookings b left join private.booking_operations o on o.booking_id=b.id where b.id=target_id;
$$;

-- T24 request: a key used for an owner entry is never a player rental.
create or replace function public.rental_booking_request(actor_user_id uuid,target_court_id uuid,request_id uuid,
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
      or not exists(select 1 from private.rental_bookings b where b.id=existing.id and b.source='player') then
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

-- Current owners record an outside rental: same review token, window, hours, arrival policy and venue→court locks as a player request.
create function public.rental_booking_owner_entry(actor_user_id uuid,target_court_id uuid,request_id uuid,
  starts timestamptz,ends timestamptz,guest_name text,expected_quote jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare existing private.court_allocations; quote jsonb; acquired jsonb; booking_id uuid; guest text:=btrim(guest_name); venue uuid;
begin
  if actor_user_id is null or request_id is null or target_court_id is null or starts is null or ends is null or guest is null
    or char_length(guest) not between 1 and 60 or guest~'[[:cntrl:]]' or not exists(select 1 from auth.users where id=actor_user_id) then
    raise exception 'Owner/input required' using errcode='22023',hint='invalid_input';
  end if;
  -- Same key space as player requests, so one key can never name both.
  perform pg_advisory_xact_lock(hashtextextended(actor_user_id::text||':'||request_id::text,24));
  select a.* into existing from private.court_allocations a where a.requested_by=actor_user_id and a.request_id=rental_booking_owner_entry.request_id;
  if found then
    if existing.kind<>'rental' or existing.court_id<>target_court_id or existing.starts_at<>starts or existing.ends_at<>ends
      or not exists(select 1 from private.rental_bookings b where b.id=existing.id and b.source='owner' and b.guest_name=guest) then
      raise exception 'Request reused' using errcode='23505',hint='request_reused';
    end if;
    perform 1 from public.venues v where v.id=existing.venue_id for share;
    -- A revoked owner cannot replay a key to read the entry.
    perform private.rental_require_owner(actor_user_id,existing.venue_id);
    perform 1 from public.courts c where c.id=existing.court_id for no key update;
    return jsonb_build_object('outcome','existing','booking',private.rental_booking_json(existing.id,clock_timestamp()));
  end if;
  select c.venue_id into venue from public.courts c where c.id=target_court_id;
  if not found then raise exception 'Court unavailable' using errcode='P0002',hint='court_unavailable'; end if;
  perform 1 from public.venues v where v.id=venue for share;
  perform private.rental_require_owner(actor_user_id,venue);
  quote:=private.rental_quote(target_court_id,starts,ends);
  if quote->>'venue_id'<>venue::text then raise exception 'Court unavailable' using errcode='P0002',hint='court_unavailable'; end if;
  if expected_quote is distinct from quote->'expected_quote' then
    raise exception 'Review changed price/policy' using errcode='40001',hint='stale_quote';
  end if;
  acquired:=private.rental_acquire(actor_user_id,target_court_id,starts,ends,null,request_id);
  booking_id:=(acquired->'allocation'->>'id')::uuid;
  insert into private.rental_bookings(id,status,source,guest_name) values(booking_id,'confirmed','owner',guest);
  insert into private.rental_events(booking_id,actor_user_id,action) values(booking_id,actor_user_id,'owner_entry');
  return jsonb_build_object('outcome','created','booking',private.rental_booking_json(booking_id,clock_timestamp()));
end;
$$;

-- T24 lifecycle; any current owner (not only the one who entered it) cancels an owner entry before it starts.
create or replace function public.rental_booking_change(actor_user_id uuid,target_booking_id uuid,command text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; b private.rental_bookings; at_time timestamptz; next_status text; result jsonb; listing public.venues; src text;
begin
  if actor_user_id is null or command is null or command not in ('accept','decline','cancel','expire')
    or not exists(select 1 from auth.users where id=actor_user_id) then
    raise exception 'Invalid command' using errcode='22023',hint='invalid_input';
  end if;
  select x.* into a from private.court_allocations x join private.rental_bookings y on y.id=x.id where x.id=target_booking_id;
  if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
  select y.source into src from private.rental_bookings y where y.id=target_booking_id;
  select v.* into listing from public.venues v where v.id=a.venue_id for share;
  if command in ('accept','decline') or src='owner' or (command='expire' and a.requested_by<>actor_user_id) then
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

-- T24 reads; player history never includes owner entries, and only current owners read them.
create or replace function public.rental_booking_read(actor_user_id uuid,target_booking_id uuid default null,
  target_venue_id uuid default null,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; rows jsonb; cursor uuid; at_time timestamptz; src text;
begin
  if actor_user_id is null or not exists(select 1 from auth.users where id=actor_user_id)
    or (target_booking_id is not null and (target_venue_id is not null or after_id is not null)) then
    raise exception 'Invalid read' using errcode='22023',hint='invalid_input';
  end if;
  if target_booking_id is not null then
    select x.* into a from private.court_allocations x join private.rental_bookings b on b.id=x.id where x.id=target_booking_id;
    if not found then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
    select b.source into src from private.rental_bookings b where b.id=target_booking_id;
    if a.requested_by<>actor_user_id or src='owner' then
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
    where (case when target_venue_id is null then ca.requested_by=actor_user_id and bk.source='player' else ca.venue_id=target_venue_id
      and bk.status='pending' and private.allocation_live(ca.state,ca.expires_at,at_time) end)
      and (after_id is null or ca.id>after_id) order by ca.id limit 26
  ), numbered as (select id,row_number() over(order by id) n from page)
  select coalesce(jsonb_agg(private.rental_booking_json(id,at_time) order by id) filter(where n<=25),'[]'::jsonb),
    case when count(*)>25 then (array_agg(id order by id))[25] end into rows,cursor from numbered;
  return jsonb_build_object('bookings',rows,'next_cursor',cursor);
end;
$$;

-- Attendance and arrival payments: current owners only, from the booking's start. Player cancellation closes at the start,
-- so a check-in or payment never meets a later player cancellation. Lock: venue (share) → owner link → booking row.
create function public.booking_operation(actor_user_id uuid,target_kind text,target_booking_id uuid,command text,
  method text default null,amount bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare venue uuid; starts timestamptz; booking_status text; session_status text; total bigint; at_time timestamptz;
  op private.booking_operations; next_attendance text; event_action text; reply jsonb;
begin
  if actor_user_id is null or target_booking_id is null or target_kind is null or target_kind not in ('rental','session')
    or command is null or command not in ('check_in','no_show','complete','record_payment')
    or (command='record_payment')<>(method is not null) or (method is null)<>(amount is null)
    or method not in ('cash','ewallet','card','bank_transfer','other') or amount not between 0 and 9007199254740991
    or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Invalid operation' using errcode='22023',hint='invalid_input';
  end if;
  if target_kind='rental' then
    select a.venue_id into venue from private.court_allocations a join private.rental_bookings b on b.id=a.id where a.id=target_booking_id;
  else
    select s.venue_id into venue from private.session_bookings b join private.open_play_sessions s on s.id=b.session_id where b.id=target_booking_id;
  end if;
  if venue is null then raise exception 'Booking unavailable' using errcode='P0002',hint='booking_not_found'; end if;
  perform 1 from public.venues v where v.id=venue for share;
  perform private.rental_require_owner(actor_user_id,venue);
  if target_kind='rental' then
    select b.status,a.starts_at,(s.snapshot->>'total_centavos')::bigint into booking_status,starts,total
      from private.rental_bookings b join private.court_allocations a on a.id=b.id join private.rental_snapshots s on s.allocation_id=b.id
      where b.id=target_booking_id for update of b;
  else
    select b.status,x.starts_at,x.status,(b.snapshot->>'total_centavos')::bigint into booking_status,starts,session_status,total
      from private.session_bookings b join private.open_play_sessions x on x.id=b.session_id where b.id=target_booking_id for update of b;
  end if;
  at_time:=clock_timestamp();
  insert into private.booking_operations(booking_id,rental_booking_id,session_booking_id)
    values(target_booking_id,case when target_kind='rental' then target_booking_id end,case when target_kind='session' then target_booking_id end)
    on conflict (booking_id) do nothing;
  select o.* into op from private.booking_operations o where o.booking_id=target_booking_id for update;
  -- Retries return the current record without another event.
  if command='record_payment' and op.paid_at is not null then
    if op.payment_method<>method or op.paid_centavos<>amount then
      raise exception 'Payment already recorded' using errcode='23505',hint='payment_recorded';
    end if;
    event_action:='existing';
  elsif command<>'record_payment' then
    next_attendance:=case command when 'check_in' then 'checked_in' when 'no_show' then 'no_show' else 'completed' end;
    if op.attendance=next_attendance or (command='check_in' and op.attendance='completed') then event_action:='existing'; end if;
  end if;
  if event_action is null then
    if booking_status<>'confirmed' or coalesce(session_status,'scheduled')<>'scheduled' then
      raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
    end if;
    if starts>at_time then raise exception 'Booking not started' using errcode='55000',hint='not_started'; end if;
    if command='record_payment' then
      if op.attendance='no_show' then raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition'; end if;
      if amount<>total then raise exception 'Amount differs from total' using errcode='23514',hint='amount_mismatch'; end if;
      update private.booking_operations o set payment_method=method,paid_centavos=amount,paid_at=at_time where o.booking_id=target_booking_id;
      event_action:='payment';
    else
      if (command in ('check_in','no_show') and op.attendance<>'none') or (command='complete' and op.attendance<>'checked_in')
        or (command='no_show' and op.paid_at is not null) then
        raise exception 'Booking cannot change' using errcode='23514',hint='invalid_transition';
      end if;
      update private.booking_operations o set attendance=next_attendance,attendance_at=at_time where o.booking_id=target_booking_id;
      event_action:=command;
    end if;
    if target_kind='rental' then insert into private.rental_events(booking_id,actor_user_id,action) values(target_booking_id,actor_user_id,event_action);
    else insert into private.session_booking_events(booking_id,actor_user_id,action) values(target_booking_id,actor_user_id,event_action); end if;
  end if;
  reply:=case target_kind when 'rental' then private.rental_booking_json(target_booking_id,clock_timestamp())
    else private.session_booking_json(target_booking_id,clock_timestamp()) end;
  return jsonb_build_object('outcome',case event_action when 'existing' then 'existing' else 'changed' end,'booking',reply);
end; $$;

-- Owner front desk: confirmed rentals (player and owner entries) or groups (player and walk-in) starting on one Manila date.
create function public.booking_operations_read(actor_user_id uuid,target_kind text,target_venue_id uuid,target_day date,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz; day_start timestamptz; ids uuid[];
begin
  if actor_user_id is null or target_kind is null or target_kind not in ('rental','session') or target_venue_id is null or target_day is null
    or target_day not between date '2000-01-01' and date '2099-12-31' or not exists(select 1 from auth.users u where u.id=actor_user_id) then
    raise exception 'Invalid read' using errcode='22023',hint='invalid_input';
  end if;
  perform 1 from public.venues v where v.id=target_venue_id for share;
  perform private.rental_require_owner(actor_user_id,target_venue_id);
  at_time:=clock_timestamp(); day_start:=target_day::timestamp at time zone 'Asia/Manila';
  if target_kind='rental' then
    select array_agg(p.id order by p.id) into ids from (select a.id from private.court_allocations a join private.rental_bookings b on b.id=a.id
      where a.venue_id=target_venue_id and a.state='active' and a.kind='rental' and b.status='confirmed'
        and a.starts_at>=day_start and a.starts_at<day_start+interval '1 day' and (after_id is null or a.id>after_id) order by a.id limit 26) p;
  else
    select array_agg(p.id order by p.id) into ids from (select b.id from private.session_bookings b join private.open_play_sessions s on s.id=b.session_id
      where s.venue_id=target_venue_id and s.status='scheduled' and b.status='confirmed'
        and s.starts_at>=day_start and s.starts_at<day_start+interval '1 day' and (after_id is null or b.id>after_id) order by b.id limit 26) p;
  end if;
  return jsonb_build_object('venue_id',target_venue_id,'date',target_day,'at',at_time,'bookings',coalesce((select jsonb_agg(case target_kind
      when 'rental' then private.rental_booking_json(i,at_time) else private.session_booking_json(i,at_time) end order by i)
    from unnest(ids[1:25]) i),'[]'::jsonb),'next_cursor',case when cardinality(ids)>25 then ids[25] end);
end; $$;

revoke all on function private.rental_booking_guard(),private.booking_operations_guard(),private.booking_operations_json(uuid),
  private.rental_booking_json(uuid,timestamptz),private.session_booking_json(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb),
  public.rental_booking_owner_entry(uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb),public.rental_booking_change(uuid,uuid,text),
  public.rental_booking_read(uuid,uuid,uuid,uuid),public.booking_operation(uuid,text,uuid,text,text,bigint),
  public.booking_operations_read(uuid,text,uuid,date,uuid) from public,anon,authenticated,service_role;
grant execute on function public.rental_booking_request(uuid,uuid,uuid,timestamptz,timestamptz,jsonb),
  public.rental_booking_owner_entry(uuid,uuid,uuid,timestamptz,timestamptz,text,jsonb),public.rental_booking_change(uuid,uuid,text),
  public.rental_booking_read(uuid,uuid,uuid,uuid),public.booking_operation(uuid,text,uuid,text,text,bigint),
  public.booking_operations_read(uuid,text,uuid,date,uuid) to service_role;
notify pgrst,'reload schema';
