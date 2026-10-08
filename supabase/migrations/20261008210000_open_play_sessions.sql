-- T27: immutable owner sessions reserve every selected court in the shared inventory.
create table private.open_play_sessions (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  created_by uuid not null,
  request_id uuid not null,
  request_input jsonb not null,
  snapshot jsonb not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null check (capacity between 1 and 200),
  -- T28 must maintain this under the session lock, including effective elapsed holds.
  reserved_spots integer not null default 0 check (reserved_spots between 0 and capacity),
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  created_at timestamptz not null default clock_timestamp(),
  cancelled_at timestamptz,
  unique(created_by,request_id),
  check ((status='cancelled')=(cancelled_at is not null)),
  check (ends_at>starts_at and ends_at-starts_at<=interval '24 hours'),
  check (mod(extract(epoch from starts_at),1800)=0 and mod(extract(epoch from ends_at),1800)=0),
  check (starts_at>=timestamptz '2000-01-01 00:00+08' and ends_at<=timestamptz '2100-01-01 00:00+08')
);
create table private.session_courts (
  session_id uuid not null references private.open_play_sessions(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  allocation_id uuid not null unique references private.court_allocations(id) on delete cascade,
  primary key(session_id,court_id)
);
create index open_play_sessions_venue on private.open_play_sessions(venue_id,starts_at,id);
alter table private.open_play_sessions enable row level security;
alter table private.session_courts enable row level security;
revoke all on private.open_play_sessions,private.session_courts from public,anon,authenticated,service_role;

create function private.session_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if (new.id,new.venue_id,new.created_by,new.request_id,new.request_input,new.snapshot,new.starts_at,new.ends_at,new.capacity,new.created_at)
    is distinct from (old.id,old.venue_id,old.created_by,old.request_id,old.request_input,old.snapshot,old.starts_at,old.ends_at,old.capacity,old.created_at)
    or (old.status='cancelled' and (new.status,new.cancelled_at) is distinct from (old.status,old.cancelled_at)) then
    raise exception 'Session snapshot is immutable' using errcode='55000',hint='immutable_session';
  end if;
  return new;
end; $$;
create trigger session_immutable before update on private.open_play_sessions for each row execute function private.session_immutable();

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
  'directory.create','directory.update','directory.publish','directory.unpublish','directory.suspend','directory.import',
  'owner.create','owner.update','owner.photo_add','owner.photo_remove','schedule.update','policy.update',
  'allocation.block','allocation.release','schedule.court_update','session.create','session.cancel'));

create function private.session_json(target_id uuid,at_time timestamptz) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('id',s.id,'venue_id',s.venue_id,'status',s.status,'created_at',s.created_at,
    'cancelled_at',s.cancelled_at,'snapshot',s.snapshot,'reserved_spots',s.reserved_spots,
    'allocations',coalesce((select jsonb_agg(private.allocation_json(a,at_time) order by a.court_id)
      from private.session_courts c join private.court_allocations a on a.id=c.allocation_id where c.session_id=s.id),'[]'::jsonb))
  from private.open_play_sessions s where s.id=target_id;
$$;

create function public.owner_session_create(actor_user_id uuid,session_input jsonb) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare venue uuid; request uuid; courts uuid[]; court_id uuid; starts timestamptz; ends timestamptz;
  capacity integer; group_limit integer; price numeric; title text; canonical jsonb; policy jsonb;
  saved private.open_play_sessions; existing private.open_play_sessions; listing public.venues;
  allocation jsonb; at_time timestamptz; revisions jsonb;
begin
  if jsonb_typeof(session_input) is distinct from 'object' or not session_input ?& array[
      'venue_id','request_id','court_ids','title','starts_at','ends_at','capacity','group_limit','price_centavos']
    or (select count(*) from jsonb_object_keys(session_input))<>9
    or jsonb_typeof(session_input->'court_ids') is distinct from 'array'
    or jsonb_array_length(session_input->'court_ids') not between 1 and 40
    or jsonb_typeof(session_input->'title') is distinct from 'string'
    or jsonb_typeof(session_input->'capacity') is distinct from 'number'
    or jsonb_typeof(session_input->'group_limit') is distinct from 'number'
    or jsonb_typeof(session_input->'price_centavos') is distinct from 'number'
    or jsonb_typeof(session_input->'venue_id') is distinct from 'string'
    or jsonb_typeof(session_input->'request_id') is distinct from 'string'
    or jsonb_typeof(session_input->'starts_at') is distinct from 'string'
    or jsonb_typeof(session_input->'ends_at') is distinct from 'string'
    or (session_input->>'starts_at')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
    or (session_input->>'ends_at')!~'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$'
    or exists(select 1 from jsonb_array_elements(session_input->'court_ids') x where jsonb_typeof(x)<>'string') then
    raise exception 'Invalid session' using errcode='22023',hint='invalid_input';
  end if;
  begin
    venue:=(session_input->>'venue_id')::uuid; request:=(session_input->>'request_id')::uuid;
    select array_agg(x::uuid order by x::uuid) into courts from jsonb_array_elements_text(session_input->'court_ids') x;
    starts:=(session_input->>'starts_at')::timestamptz; ends:=(session_input->>'ends_at')::timestamptz;
    capacity:=(session_input->>'capacity')::integer; group_limit:=(session_input->>'group_limit')::integer;
    price:=(session_input->>'price_centavos')::numeric; title:=btrim(session_input->>'title');
  exception when others then raise exception 'Invalid session' using errcode='22023',hint='invalid_input'; end;
  if actor_user_id is null or venue is null or request is null or starts is null or ends is null
    or not isfinite(starts) or not isfinite(ends) or length(title) not between 1 and 80 or title~'[[:cntrl:]]'
    or capacity not between 1 and 200 or group_limit not between 1 and capacity
    or price<0 or price<>trunc(price) or price*capacity>9007199254740991
    or cardinality(courts)<>(select count(distinct x) from unnest(courts) x) then
    raise exception 'Invalid session' using errcode='22023',hint='invalid_input';
  end if;
  canonical:=jsonb_build_object('venue_id',venue,'request_id',request,'court_ids',to_jsonb(courts),
    'title',title,'starts_at',starts,'ends_at',ends,'capacity',capacity,'group_limit',group_limit,'price_centavos',price);
  -- Serialize a retry even when it changes its venue/court set; acquire all courts in UUID order.
  perform pg_advisory_xact_lock(hashtextextended('session:'||actor_user_id::text||':'||request::text,0));
  select v.* into listing from public.venues v where v.id=venue for share;
  perform private.rental_require_owner(actor_user_id,venue);
  select s.* into existing from private.open_play_sessions s where s.created_by=actor_user_id and s.request_id=request;
  if found then
    if existing.request_input<>canonical then raise exception 'Request already used' using errcode='23505',hint='request_reused'; end if;
    return jsonb_build_object('outcome','existing','session',private.session_json(existing.id,clock_timestamp()));
  end if;
  if listing.publication_status is distinct from 'approved' then
    raise exception 'Venue unavailable' using errcode='P0002',hint='venue_unavailable';
  end if;
  -- Never lock another venue's court under this venue's lock.
  perform 1 from public.courts c where c.id=any(courts) and c.venue_id=venue order by c.id for no key update;
  if (select count(*) from public.courts c where c.id=any(courts) and c.venue_id=venue and c.status='active')<>cardinality(courts) then
    raise exception 'Court unavailable' using errcode='P0002',hint='court_unavailable';
  end if;
  perform 1 from private.venue_merchants m where m.venue_id=venue for share;
  at_time:=clock_timestamp();
  if starts<=at_time or starts>at_time+interval '60 days' or ends<=starts or ends-starts>interval '24 hours'
    or mod(extract(epoch from starts),1800)<>0 or mod(extract(epoch from ends),1800)<>0
    or starts<timestamptz '2000-01-01 00:00+08' or ends>timestamptz '2100-01-01 00:00+08' then
    raise exception 'Invalid session time' using errcode='22023',hint='invalid_input';
  end if;
  policy:=private.venue_policy_view(venue);
  select jsonb_agg(jsonb_build_object('court_id',c.id,'revision',h.revision::text) order by c.id) into revisions
    from public.courts c left join private.court_schedules h on h.court_id=c.id where c.id=any(courts);
  insert into private.open_play_sessions(venue_id,created_by,request_id,request_input,starts_at,ends_at,capacity,snapshot)
    values(venue,actor_user_id,request,canonical,starts,ends,capacity,jsonb_build_object(
      'title',title,'court_ids',to_jsonb(courts),'starts_at',starts,'ends_at',ends,'capacity',capacity,
      'group_limit',group_limit,'price_centavos',price,'currency','PHP','timezone','Asia/Manila',
      'policy',policy-'venue_id'-'revision','policy_revision',policy->>'revision',
      'schedule_revision',(select s.revision::text from private.venue_schedules s where s.venue_id=venue),
      'court_hours_revisions',revisions,'approval_hold_minutes',120,'payment_hold_minutes',15,'refund_cutoff_hours',24)) returning * into saved;
  foreach court_id in array courts loop
    -- Independent allocation retry IDs: the session command owns multi-court retry identity.
    allocation:=private.allocation_acquire(court_id,'session',starts,ends,null,actor_user_id,gen_random_uuid());
    insert into private.session_courts(session_id,court_id,allocation_id) values(saved.id,court_id,(allocation->'allocation'->>'id')::uuid);
  end loop;
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action) values(actor_user_id,venue,'session.create');
  return jsonb_build_object('outcome','created','session',private.session_json(saved.id,at_time));
end; $$;

-- Only empty sessions here. T31 extends cancellation to bookings/refunds.
create function public.owner_session_cancel(actor_user_id uuid,target_session_id uuid) returns jsonb
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
  if saved.reserved_spots>0 then raise exception 'Session has bookings' using errcode='55000',hint='session_has_bookings'; end if;
  if saved.starts_at<=clock_timestamp() then raise exception 'Session already started' using errcode='55000',hint='session_started'; end if;
  for allocation in select sc.allocation_id from private.session_courts sc where sc.session_id=saved.id order by sc.court_id loop
    perform private.allocation_release(allocation);
  end loop;
  update private.open_play_sessions set status='cancelled',cancelled_at=clock_timestamp() where id=saved.id;
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action) values(actor_user_id,saved.venue_id,'session.cancel');
  return jsonb_build_object('outcome','cancelled','session',private.session_json(saved.id,clock_timestamp()));
end; $$;

-- Bounded UUID keyset pages. Current venue owner only; cancellation/history remains available under suspension.
create function public.owner_session_read(actor_user_id uuid,target_venue_id uuid,after_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ids uuid[]; at_time timestamptz:=clock_timestamp();
begin
  perform 1 from public.venues v where v.id=target_venue_id for share;
  perform private.rental_require_owner(actor_user_id,target_venue_id);
  select array_agg(s.id order by s.id) into ids from (select x.id from private.open_play_sessions x
    where x.venue_id=target_venue_id and (after_id is null or x.id>after_id) order by x.id limit 26) s;
  return jsonb_build_object('venue_id',target_venue_id,'at',at_time,'sessions',coalesce((select jsonb_agg(private.session_json(i,at_time) order by i)
    from unnest(ids[1:25]) i),'[]'::jsonb),'next_cursor',case when cardinality(ids)>25 then ids[25] else null end);
end; $$;

revoke all on function private.session_immutable(),private.session_json(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.owner_session_create(uuid,jsonb),public.owner_session_cancel(uuid,uuid),public.owner_session_read(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.owner_session_create(uuid,jsonb),public.owner_session_cancel(uuid,uuid),public.owner_session_read(uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
