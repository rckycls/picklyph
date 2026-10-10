-- T44: one push about an hour before a confirmed player booking starts, through the T43
-- outbox. One reminder per booking; the worker re-checks the booking when it claims the
-- row, so a cancelled or started booking is never reminded. See docs/notifications.md.

alter table private.notification_outbox drop constraint notification_outbox_source_check;
alter table private.notification_outbox add constraint notification_outbox_source_check
  check (source in ('rental','session','reminder'));
alter table private.notification_outbox drop constraint notification_outbox_kind_check;
alter table private.notification_outbox add constraint notification_outbox_kind_check
  check (kind in ('booking.requested','booking.created','booking.accepted','booking.declined',
    'booking.expired','booking.cancelled','payment.recorded','booking.reminder'));

-- One row per reminded booking, whether or not the player had a device then, so the sweep
-- decides each booking once. Its id is the outbox row's event_id (source 'reminder').
create table private.booking_reminders (
  id bigint generated always as identity primary key,
  rental_booking_id uuid unique references private.rental_bookings(id) on delete cascade,
  session_booking_id uuid unique references private.session_bookings(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  check ((rental_booking_id is null) <> (session_booking_id is null))
);
create index booking_reminders_created on private.booking_reminders(created_at);
alter table private.booking_reminders enable row level security;
revoke all on private.booking_reminders from public, anon, authenticated, service_role;
revoke all on sequence private.booking_reminders_id_seq from public, anon, authenticated, service_role;

-- The sweep reads upcoming starts only.
create index court_allocations_rental_starts on private.court_allocations(starts_at) where kind = 'rental' and state = 'active';
create index open_play_sessions_scheduled_starts on private.open_play_sessions(starts_at) where status = 'scheduled';

-- Confirmed player rentals and groups starting in (at_time, at_time + 1 hour] that have no
-- reminder yet get one, and an outbox row for a player with an active device. Owner entries
-- and walk-ins are never reminded. Concurrent sweeps insert each reminder once. Reminders
-- older than two days (their bookings have started) are pruned, bounded.
create function private.booking_reminders_enqueue(at_time timestamptz, batch_limit integer default 200) returns integer
language plpgsql security definer set search_path='' as $$
declare due record; reminder bigint; made integer := 0;
begin
  if at_time is null or batch_limit is null or batch_limit not between 1 and 1000 then
    raise exception 'Invalid reminder sweep' using errcode = '22023', hint = 'invalid_request';
  end if;
  delete from private.booking_reminders r where r.id in (select x.id from private.booking_reminders x
    where x.created_at < at_time - interval '2 days' order by x.created_at limit 500);
  for due in select * from (
      select 'rental'::text as booking_kind, b.id as booking, a.requested_by as player, a.venue_id as venue, a.starts_at as starts
      from private.court_allocations a join private.rental_bookings b on b.id = a.id
      where a.kind = 'rental' and a.state = 'active' and b.status = 'confirmed' and b.source = 'player'
        and a.starts_at > at_time and a.starts_at <= at_time + interval '1 hour'
        and not exists (select 1 from private.booking_reminders r where r.rental_booking_id = b.id)
      union all
      select 'group', g.id, g.requested_by, s.venue_id, s.starts_at
      from private.open_play_sessions s join private.session_bookings g on g.session_id = s.id
      where s.status = 'scheduled' and g.status = 'confirmed' and g.source = 'player'
        and s.starts_at > at_time and s.starts_at <= at_time + interval '1 hour'
        and not exists (select 1 from private.booking_reminders r where r.session_booking_id = g.id)
    ) x order by x.starts, x.booking limit batch_limit loop
    insert into private.booking_reminders(rental_booking_id, session_booking_id)
      values (case when due.booking_kind = 'rental' then due.booking end, case when due.booking_kind = 'group' then due.booking end)
      on conflict do nothing returning id into reminder;
    if not found then continue; end if;
    made := made + 1;
    perform private.notification_enqueue('reminder', reminder, 'booking.reminder', array[due.player], jsonb_build_object(
      'audience', 'player', 'booking_kind', due.booking_kind, 'booking_id', due.booking, 'venue_id', due.venue,
      'venue_name', (select v.name from public.venues v where v.id = due.venue),
      'starts_at', to_char(due.starts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  end loop;
  return made;
end; $$;

-- A reminder still applies while its booking is confirmed and has not started.
create function private.booking_reminder_due(reminder bigint, at_time timestamptz) returns boolean
language sql stable security definer set search_path='' as $$
  select exists (select 1 from private.booking_reminders r
      join private.rental_bookings b on b.id = r.rental_booking_id
      join private.court_allocations a on a.id = b.id
      where r.id = reminder and b.status = 'confirmed' and a.state = 'active' and a.starts_at > at_time)
    or exists (select 1 from private.booking_reminders r
      join private.session_bookings g on g.id = r.session_booking_id
      join private.open_play_sessions s on s.id = g.session_id
      where r.id = reminder and g.status = 'confirmed' and s.status = 'scheduled' and s.starts_at > at_time);
$$;

-- T43 claim, plus: a reminder whose booking was cancelled or has started is dropped
-- ('obsolete') instead of sent, and each item names its recipient for app routing (T44).
create or replace function public.push_outbox_claim(batch_limit integer default 25, lease_seconds integer default 120) returns jsonb
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
    if item.source = 'reminder' and not private.booking_reminder_due(item.event_id, at_time) then
      update private.notification_outbox set status = 'dropped', last_error = 'obsolete', claim_id = null, locked_until = null, finished_at = at_time
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
      'recipient', item.recipient_user_id, 'payload', item.payload, 'devices', devices));
  end loop;
  return jsonb_build_object('items', items, 'more', seen = batch_limit);
end; $$;

-- T43 cron hook, plus: reminders now due join the outbox first, in the same run.
create or replace function private.push_dispatch_kick() returns bigint
language plpgsql security definer set search_path='' as $$
declare at_time timestamptz := clock_timestamp(); target text; secret text;
begin
  perform private.booking_reminders_enqueue(at_time, 200);
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

revoke all on function private.booking_reminders_enqueue(timestamptz,integer), private.booking_reminder_due(bigint,timestamptz)
  from public, anon, authenticated, service_role;
