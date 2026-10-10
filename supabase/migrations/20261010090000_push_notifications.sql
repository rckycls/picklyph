-- T43: push device registration, a transactional notification outbox fed by booking
-- events, and the service-only commands the push-dispatch worker runs. Push is
-- supplementary: booking screens stay authoritative. See docs/notifications.md.

-- One row per Expo push token. A token belongs to one account at a time; registering
-- it from another account moves it, because the phone changed accounts.
create table private.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique check (token ~ '^Expo(nent)?PushToken\[[!-Z^-~]{1,200}\]$'),
  platform text not null check (platform in ('ios','android')),
  created_at timestamptz not null default clock_timestamp(),
  seen_at timestamptz not null default clock_timestamp(),
  -- Set when Expo reports DeviceNotRegistered; the app re-enables it by registering again.
  disabled_at timestamptz
);
create index push_devices_user on private.push_devices(user_id, seen_at);

-- One row per event and recipient, written in the event's own transaction. Only
-- recipients with an active device get a row; nothing else is kept about them.
create table private.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('rental','session')),
  event_id bigint not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('booking.requested','booking.created','booking.accepted','booking.declined',
    'booking.expired','booking.cancelled','payment.recorded')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','dropped')),
  attempts integer not null default 0 check (attempts between 0 and 100),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claim_id uuid,
  locked_until timestamptz,
  last_error text check (last_error ~ '^[a-z_]{1,40}$'),
  created_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  unique (source, event_id, recipient_user_id),
  check ((status='sending') = (claim_id is not null and locked_until is not null)),
  check ((status in ('sent','failed','dropped')) = (finished_at is not null))
);
create index notification_outbox_due on private.notification_outbox(next_attempt_at, id) where status='pending';
create index notification_outbox_leased on private.notification_outbox(locked_until) where status='sending';
create index notification_outbox_finished on private.notification_outbox(finished_at) where finished_at is not null;

-- One accepted Expo ticket per row and device, so a retry never resends to a device Expo already took.
create table private.push_deliveries (
  outbox_id uuid not null references private.notification_outbox(id) on delete cascade,
  device_id uuid not null references private.push_devices(id) on delete cascade,
  ticket_id text unique check (ticket_id ~ '^[A-Za-z0-9-]{1,100}$'),
  sent_at timestamptz not null default clock_timestamp(),
  receipt text check (receipt in ('ok','error','unknown')),
  receipt_error text check (receipt_error ~ '^[a-z_]{1,40}$'),
  primary key (outbox_id, device_id),
  check (receipt_error is null or receipt='error'),
  check (ticket_id is not null or receipt='unknown')
);
create index push_deliveries_receipts on private.push_deliveries(sent_at) where receipt is null;

alter table private.push_devices enable row level security;
alter table private.notification_outbox enable row level security;
alter table private.push_deliveries enable row level security;
revoke all on private.push_devices, private.notification_outbox, private.push_deliveries from public, anon, authenticated, service_role;

-- T47: no new device may name an account whose deletion has started.
create trigger push_devices_account_deleting before insert on private.push_devices
  for each row execute function private.refuse_deleting_account('user_id');

-- Recipients with an active device and no deletion in progress get one row each. A
-- notification must never block a booking, so a recipient deleted concurrently is skipped.
create function private.notification_enqueue(src text, source_event bigint, event_kind text, recipients uuid[], body jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into private.notification_outbox(source, event_id, recipient_user_id, kind, payload)
  select src, source_event, r.id, event_kind, body from (select distinct unnest(recipients) as id) r
  where r.id is not null
    and exists (select 1 from private.push_devices d where d.user_id = r.id and d.disabled_at is null)
    and not exists (select 1 from private.account_deletions d where d.user_id = r.id)
  on conflict (source, event_id, recipient_user_id) do nothing;
exception when foreign_key_violation then
  null;
end; $$;

-- Who hears about a booking event: the venue's current owners for a player's request or
-- cancellation; the player for an acceptance, decline, expiry, venue cancellation or a
-- recorded arrival payment. Owner entries, walk-ins and attendance notify nobody, and the
-- actor never hears about their own action.
create function private.notification_for_event(src text, source_event bigint, booking uuid, actor uuid, event_action text,
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
    || case when event_action = 'payment' and amount is not null then jsonb_build_object('amount_centavos', amount) else '{}'::jsonb end);
end; $$;

create function private.rental_event_notify() returns trigger
language plpgsql security definer set search_path='' as $$
declare a private.court_allocations; b private.rental_bookings;
begin
  select * into b from private.rental_bookings x where x.id = new.booking_id;
  if b.source <> 'player' then return null; end if;
  select * into a from private.court_allocations x where x.id = new.booking_id;
  perform private.notification_for_event('rental', new.id, b.id, new.actor_user_id, new.action, a.requested_by, a.venue_id, a.starts_at, b.status,
    (select o.paid_centavos from private.booking_operations o where o.booking_id = b.id));
  return null;
end; $$;
create trigger rental_events_notify after insert on private.rental_events
  for each row execute function private.rental_event_notify();

create function private.session_event_notify() returns trigger
language plpgsql security definer set search_path='' as $$
declare b private.session_bookings; s private.open_play_sessions;
begin
  select * into b from private.session_bookings x where x.id = new.booking_id;
  if b.source <> 'player' then return null; end if;
  select * into s from private.open_play_sessions x where x.id = b.session_id;
  perform private.notification_for_event('session', new.id, b.id, new.actor_user_id, new.action, b.requested_by, s.venue_id, s.starts_at, b.status,
    (select o.paid_centavos from private.booking_operations o where o.booking_id = b.id));
  return null;
end; $$;
create trigger session_booking_events_notify after insert on private.session_booking_events
  for each row execute function private.session_event_notify();

-- Server-only: the push-devices function passes the verified actor. Registering is
-- idempotent, re-enables a disabled token, moves a token from another account and keeps
-- an account's ten most recently seen devices.
create function public.push_device_register(actor_user_id uuid, device_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare device_token text; device_platform text; existing private.push_devices; at_time timestamptz;
begin
  if actor_user_id is null or jsonb_typeof(device_input) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(device_input) k) is distinct from array['platform','token']
    or jsonb_typeof(device_input->'token') <> 'string' or jsonb_typeof(device_input->'platform') <> 'string' then
    raise exception 'Invalid device' using errcode = '22023', hint = 'invalid_request';
  end if;
  device_token := device_input->>'token'; device_platform := device_input->>'platform';
  if device_token !~ '^Expo(nent)?PushToken\[[!-Z^-~]{1,200}\]$' or device_platform not in ('ios','android') then
    raise exception 'Invalid device' using errcode = '22023', hint = 'invalid_request';
  end if;
  if not exists (select 1 from auth.users u where u.id = actor_user_id) then
    raise exception 'Account required' using errcode = 'P0002', hint = 'account_required';
  end if;
  -- Every registration locks the account, then the token, so the device cap and token moves serialize.
  perform pg_advisory_xact_lock(hashtextextended('push-account:' || actor_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('push-token:' || device_token, 0));
  -- The insert trigger covers new rows; refreshing an existing row is refused the same way.
  perform 1 from public.profiles p where p.id = actor_user_id for key share;
  if exists (select 1 from private.account_deletions d where d.user_id = actor_user_id) then
    raise exception 'Account deletion in progress' using errcode = '42501', hint = 'account_deleted';
  end if;
  at_time := clock_timestamp();
  select * into existing from private.push_devices d where d.token = device_token for update;
  if found and existing.user_id = actor_user_id then
    update private.push_devices set platform = device_platform, seen_at = at_time, disabled_at = null where id = existing.id;
  else
    -- A new row (new id) for a moved token, so the previous account's deliveries never follow it.
    if found then delete from private.push_devices where id = existing.id; end if;
    insert into private.push_devices(user_id, token, platform, created_at, seen_at) values (actor_user_id, device_token, device_platform, at_time, at_time);
  end if;
  delete from private.push_devices d where d.id in (select x.id from private.push_devices x where x.user_id = actor_user_id
    order by x.seen_at desc, x.id desc offset 10);
  return jsonb_build_object('status', 'registered');
end; $$;

-- Removes the token only from the caller's own account; the reply never says whether it existed.
create function public.push_device_unregister(actor_user_id uuid, device_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare device_token text;
begin
  if actor_user_id is null or jsonb_typeof(device_input) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(device_input) k) is distinct from array['token']
    or jsonb_typeof(device_input->'token') <> 'string' or (device_input->>'token') !~ '^Expo(nent)?PushToken\[[!-Z^-~]{1,200}\]$' then
    raise exception 'Invalid device' using errcode = '22023', hint = 'invalid_request';
  end if;
  device_token := device_input->>'token';
  perform pg_advisory_xact_lock(hashtextextended('push-account:' || actor_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('push-token:' || device_token, 0));
  delete from private.push_devices d where d.token = device_token and d.user_id = actor_user_id;
  return jsonb_build_object('status', 'removed');
end; $$;

-- Worker step 1. Leases due rows (pending and due, or sending with an expired lease) with
-- SKIP LOCKED, so concurrent workers get disjoint rows, and returns each with the
-- recipient's active devices that have no ticket for it yet. Rows older than six hours
-- are dropped as stale; rows with nothing left to send finish here. Housekeeping is bounded.
create function public.push_outbox_claim(batch_limit integer default 25, lease_seconds integer default 120) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz := clock_timestamp(); item private.notification_outbox; devices jsonb; items jsonb := '[]'; seen integer := 0;
begin
  if batch_limit is null or batch_limit not between 1 and 100 or lease_seconds is null or lease_seconds not between 30 and 600 then
    raise exception 'Invalid claim' using errcode = '22023', hint = 'invalid_request';
  end if;
  delete from private.notification_outbox o where o.id in (select x.id from private.notification_outbox x
    where x.finished_at < at_time - interval '30 days' order by x.finished_at limit 500 for update skip locked);
  delete from private.push_devices d where d.id in (select x.id from private.push_devices x
    where x.disabled_at < at_time - interval '30 days' limit 100 for update skip locked);
  for item in select * from private.notification_outbox o
      where (o.status = 'pending' and o.next_attempt_at <= at_time) or (o.status = 'sending' and o.locked_until <= at_time)
      order by o.next_attempt_at, o.id limit batch_limit for update skip locked loop
    seen := seen + 1;
    if item.created_at < at_time - interval '6 hours' then
      update private.notification_outbox set status = 'dropped', last_error = 'stale', claim_id = null, locked_until = null, finished_at = at_time
        where id = item.id;
      continue;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'token', d.token) order by d.seen_at desc, d.id), '[]') into devices
      from private.push_devices d where d.user_id = item.recipient_user_id and d.disabled_at is null
        and not exists (select 1 from private.push_deliveries p where p.outbox_id = item.id and p.device_id = d.id);
    if devices = '[]'::jsonb then
      update private.notification_outbox set claim_id = null, locked_until = null, finished_at = at_time,
        status = case when exists (select 1 from private.push_deliveries p where p.outbox_id = item.id) then 'sent' else 'dropped' end,
        last_error = case when exists (select 1 from private.push_deliveries p where p.outbox_id = item.id) then null else 'no_devices' end
        where id = item.id;
      continue;
    end if;
    update private.notification_outbox set status = 'sending', claim_id = gen_random_uuid(),
      locked_until = at_time + make_interval(secs => lease_seconds), attempts = attempts + 1
      where id = item.id returning * into item;
    items := items || jsonb_build_array(jsonb_build_object('id', item.id, 'claim_id', item.claim_id, 'kind', item.kind,
      'payload', item.payload, 'devices', devices));
  end loop;
  return jsonb_build_object('items', items, 'more', seen = batch_limit);
end; $$;

-- Worker step 2. Applies each device outcome for rows the caller still holds (same claim,
-- still sending); a reply from an expired lease changes nothing. ok records the ticket,
-- invalid disables the token, retry backs off (30 s doubling, at most 15 min, or Expo's
-- Retry-After) for up to five attempts, error fails the row with a fixed code.
create function public.push_outbox_complete(results jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry jsonb; delivery jsonb; item private.notification_outbox; device private.push_devices; at_time timestamptz := clock_timestamp();
  failure text; outcome text; remaining boolean; delivered boolean; wait integer; done integer := 0; stale integer := 0;
begin
  -- The whole batch is checked before anything changes.
  if jsonb_typeof(results) is distinct from 'array' or jsonb_array_length(results) > 100 then
    raise exception 'Invalid results' using errcode = '22023', hint = 'invalid_request';
  end if;
  if exists (select 1 from jsonb_array_elements(results) e where jsonb_typeof(e.value) <> 'object'
      or jsonb_typeof(e.value->'deliveries') is distinct from 'array'
      or coalesce(e.value->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(e.value->>'claim_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (e.value ? 'retry_after_seconds' and case when jsonb_typeof(e.value->'retry_after_seconds') = 'number'
        then (e.value->>'retry_after_seconds')::numeric not between 0 and 3600 else true end)) then
    raise exception 'Invalid results' using errcode = '22023', hint = 'invalid_request';
  end if;
  if exists (select 1 from jsonb_array_elements(results) e where jsonb_array_length(e.value->'deliveries') > 20)
    or exists (select 1 from jsonb_array_elements(results) e cross join lateral jsonb_array_elements(e.value->'deliveries') d
      where jsonb_typeof(d.value) <> 'object' or coalesce(d.value->>'outcome', '') not in ('ok','invalid','retry','error')
        or coalesce(d.value->>'device_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or (d.value->>'outcome' = 'error' and coalesce(d.value->>'error', '') !~ '^[a-z_]{1,40}$')
        or (d.value ? 'ticket_id' and jsonb_typeof(d.value->'ticket_id') <> 'null'
          and coalesce(d.value->>'ticket_id', '') !~ '^[A-Za-z0-9-]{1,100}$')) then
    raise exception 'Invalid results' using errcode = '22023', hint = 'invalid_request';
  end if;
  for entry in select value from jsonb_array_elements(results) loop
    select * into item from private.notification_outbox o where o.id = (entry->>'id')::uuid for update;
    if not found or item.status <> 'sending' or item.claim_id <> (entry->>'claim_id')::uuid then
      stale := stale + 1; continue;
    end if;
    failure := null;
    for delivery in select value from jsonb_array_elements(entry->'deliveries') loop
      outcome := delivery->>'outcome';
      -- A device moved to another account or removed since the claim is skipped.
      select * into device from private.push_devices d where d.id = (delivery->>'device_id')::uuid and d.user_id = item.recipient_user_id;
      if not found then continue; end if;
      if outcome = 'ok' then
        insert into private.push_deliveries(outbox_id, device_id, ticket_id, sent_at, receipt)
          values (item.id, device.id, delivery->>'ticket_id', at_time, case when delivery->>'ticket_id' is null then 'unknown' end)
          on conflict do nothing;
      elsif outcome = 'invalid' then
        update private.push_devices set disabled_at = at_time where id = device.id and disabled_at is null;
      elsif outcome = 'error' then
        failure := coalesce(failure, delivery->>'error');
      end if;
    end loop;
    delivered := exists (select 1 from private.push_deliveries p where p.outbox_id = item.id);
    remaining := exists (select 1 from private.push_devices d where d.user_id = item.recipient_user_id and d.disabled_at is null
      and not exists (select 1 from private.push_deliveries p where p.outbox_id = item.id and p.device_id = d.id));
    if failure is not null or (remaining and item.attempts >= 5) then
      update private.notification_outbox set status = 'failed', last_error = coalesce(failure, 'retries_exhausted'),
        claim_id = null, locked_until = null, finished_at = at_time where id = item.id;
    elsif remaining then
      wait := greatest(least(30 * power(2, item.attempts - 1), 900)::integer, ceil(coalesce((entry->>'retry_after_seconds')::numeric, 0))::integer);
      update private.notification_outbox set status = 'pending', claim_id = null, locked_until = null,
        next_attempt_at = at_time + make_interval(secs => wait) where id = item.id;
    else
      update private.notification_outbox set status = case when delivered then 'sent' else 'dropped' end,
        last_error = case when delivered then null else 'no_devices' end, claim_id = null, locked_until = null, finished_at = at_time
        where id = item.id;
    end if;
    done := done + 1;
  end loop;
  return jsonb_build_object('completed', done, 'stale', stale);
end; $$;

-- Worker step 3. Tickets whose receipts Expo should have by now (15 minutes after
-- sending); after 24 hours Expo no longer has them, so they are marked unknown.
create function public.push_receipts_due(batch_limit integer default 300) returns jsonb
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz := clock_timestamp();
begin
  if batch_limit is null or batch_limit not between 1 and 1000 then
    raise exception 'Invalid receipts' using errcode = '22023', hint = 'invalid_request';
  end if;
  update private.push_deliveries p set receipt = 'unknown' where (p.outbox_id, p.device_id) in (select x.outbox_id, x.device_id
    from private.push_deliveries x where x.receipt is null and x.sent_at < at_time - interval '24 hours' limit 1000 for update skip locked);
  return jsonb_build_object('tickets', (select coalesce(jsonb_agg(x.ticket_id order by x.sent_at, x.ticket_id), '[]') from (
    select p.ticket_id, p.sent_at from private.push_deliveries p where p.receipt is null and p.sent_at <= at_time - interval '15 minutes'
    order by p.sent_at, p.ticket_id limit batch_limit) x));
end; $$;

-- Worker step 4. Records receipts once; DeviceNotRegistered disables the token.
create function public.push_receipts_record(results jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare entry jsonb; outcome text; device uuid; recorded integer := 0;
begin
  if jsonb_typeof(results) is distinct from 'array' or jsonb_array_length(results) > 1000 then
    raise exception 'Invalid receipts' using errcode = '22023', hint = 'invalid_request';
  end if;
  for entry in select value from jsonb_array_elements(results) loop
    outcome := entry->>'outcome';
    if jsonb_typeof(entry) <> 'object' or coalesce(entry->>'ticket_id', '') !~ '^[A-Za-z0-9-]{1,100}$'
      or outcome is null or outcome not in ('ok','invalid','error')
      or (outcome = 'error' and coalesce(entry->>'error', '') !~ '^[a-z_]{1,40}$') then
      raise exception 'Invalid receipts' using errcode = '22023', hint = 'invalid_request';
    end if;
    update private.push_deliveries p set receipt = case when outcome = 'ok' then 'ok' else 'error' end,
      receipt_error = case outcome when 'ok' then null when 'invalid' then 'device_not_registered' else entry->>'error' end
      where p.ticket_id = entry->>'ticket_id' and p.receipt is null returning p.device_id into device;
    if found then
      recorded := recorded + 1;
      if outcome = 'invalid' then
        update private.push_devices set disabled_at = clock_timestamp() where id = device and disabled_at is null;
      end if;
    end if;
  end loop;
  return jsonb_build_object('recorded', recorded);
end; $$;

-- pg_cron calls this every minute. It calls the push-dispatch function (pg_net) only when
-- something is due; the URL and worker secret live in Vault (operator step, docs/notifications.md).
create function private.push_dispatch_kick() returns bigint
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz := clock_timestamp(); target text; secret text;
begin
  if not exists (select 1 from private.notification_outbox o where o.status = 'pending' and o.next_attempt_at <= at_time)
    and not exists (select 1 from private.notification_outbox o where o.status = 'sending' and o.locked_until <= at_time)
    and not exists (select 1 from private.push_deliveries p where p.receipt is null and p.sent_at <= at_time - interval '15 minutes') then
    return null;
  end if;
  select s.decrypted_secret into target from vault.decrypted_secrets s where s.name = 'push_dispatch_url';
  select s.decrypted_secret into secret from vault.decrypted_secrets s where s.name = 'push_worker_secret';
  if target is null or secret is null then
    raise exception 'Push dispatch is not configured' using errcode = '55000', hint = 'not_configured';
  end if;
  return net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 30000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret));
end; $$;

-- Idempotent: pg_cron updates the named job. Run only after the Vault secrets exist.
create function private.push_dispatch_schedule() returns bigint
language plpgsql set search_path='' as $$
begin
  return cron.schedule('push-dispatch', '* * * * *', 'select private.push_dispatch_kick()');
end; $$;

revoke all on function private.notification_enqueue(text,bigint,text,uuid[],jsonb),
  private.notification_for_event(text,bigint,uuid,uuid,text,uuid,uuid,timestamptz,text,bigint),
  private.rental_event_notify(), private.session_event_notify(), private.push_dispatch_kick(), private.push_dispatch_schedule(),
  public.push_device_register(uuid,jsonb), public.push_device_unregister(uuid,jsonb), public.push_outbox_claim(integer,integer),
  public.push_outbox_complete(jsonb), public.push_receipts_due(integer), public.push_receipts_record(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.push_device_register(uuid,jsonb), public.push_device_unregister(uuid,jsonb),
  public.push_outbox_claim(integer,integer), public.push_outbox_complete(jsonb), public.push_receipts_due(integer),
  public.push_receipts_record(jsonb) to service_role;
