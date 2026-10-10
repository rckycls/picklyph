-- T45: account-wide booking alert topics. A recipient who muted a topic gets no outbox
-- row for it; every other recipient is unaffected. Push stays supplementary: muting
-- changes nothing about bookings. See docs/notifications.md.

-- Muted topics per account, stored sorted and distinct. No row means every topic is on.
create table private.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  muted text[] not null default '{}' check (muted <@ array['bookings','payments','reminders','requests','updates']::text[] and cardinality(muted) <= 5),
  updated_at timestamptz not null default clock_timestamp()
);
alter table private.notification_preferences enable row level security;
revoke all on private.notification_preferences from public, anon, authenticated, service_role;

-- T47: no preferences row may be created for an account whose deletion has started.
create trigger notification_preferences_account_deleting before insert on private.notification_preferences
  for each row execute function private.refuse_deleting_account('user_id');

-- The switch that governs a notification. Owners: requests (needs an answer) and bookings
-- (new or cancelled). Players: updates (accepted, declined, expired, cancelled), payments
-- and reminders.
create function private.notification_topic(audience text, kind text) returns text
language sql immutable set search_path='' as $$
  select case
    when audience = 'owner' and kind = 'booking.requested' then 'requests'
    when audience = 'owner' and kind in ('booking.created','booking.cancelled') then 'bookings'
    when audience = 'player' and kind in ('booking.accepted','booking.declined','booking.expired','booking.cancelled') then 'updates'
    when audience = 'player' and kind = 'payment.recorded' then 'payments'
    when audience = 'player' and kind = 'booking.reminder' then 'reminders'
  end;
$$;

-- T43 enqueue, plus: a recipient who muted the notification's topic gets no row. The T44
-- reminder sweep records its decision before this, so unmuting never resends a reminder.
create or replace function private.notification_enqueue(src text, source_event bigint, event_kind text, recipients uuid[], body jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into private.notification_outbox(source, event_id, recipient_user_id, kind, payload)
  select src, source_event, r.id, event_kind, body from (select distinct unnest(recipients) as id) r
  where r.id is not null
    and exists (select 1 from private.push_devices d where d.user_id = r.id and d.disabled_at is null)
    and not exists (select 1 from private.account_deletions d where d.user_id = r.id)
    and not exists (select 1 from private.notification_preferences p where p.user_id = r.id
      and private.notification_topic(body->>'audience', event_kind) = any(p.muted))
  on conflict (source, event_id, recipient_user_id) do nothing;
exception when foreign_key_violation then
  null;
end; $$;

-- Server-only: the push-devices function passes the verified actor.
create function public.notification_preferences_read(actor_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if actor_user_id is null then
    raise exception 'Invalid preferences' using errcode = '22023', hint = 'invalid_request';
  end if;
  return jsonb_build_object('muted', coalesce((select to_jsonb(p.muted) from private.notification_preferences p
    where p.user_id = actor_user_id), '[]'::jsonb));
end; $$;

-- Replaces the caller's whole set: `{muted: [topic, ...]}`, known topics only, no
-- duplicates. Refused once account deletion has started: the T47 insert trigger runs
-- before the upsert's conflict check, so it covers changing an existing row too.
create function public.notification_preferences_save(actor_user_id uuid, preferences_input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare topics text[];
begin
  if actor_user_id is null or jsonb_typeof(preferences_input) is distinct from 'object'
    or (select array_agg(k) from jsonb_object_keys(preferences_input) k) is distinct from array['muted']
    or jsonb_typeof(preferences_input->'muted') is distinct from 'array' or jsonb_array_length(preferences_input->'muted') > 5
    or exists (select 1 from jsonb_array_elements(preferences_input->'muted') e where jsonb_typeof(e.value) <> 'string'
      or (e.value #>> '{}') not in ('bookings','payments','reminders','requests','updates'))
    or (select count(distinct e.value) from jsonb_array_elements(preferences_input->'muted') e) <> jsonb_array_length(preferences_input->'muted') then
    raise exception 'Invalid preferences' using errcode = '22023', hint = 'invalid_request';
  end if;
  if not exists (select 1 from auth.users u where u.id = actor_user_id) then
    raise exception 'Account required' using errcode = 'P0002', hint = 'account_required';
  end if;
  topics := array(select e.value #>> '{}' from jsonb_array_elements(preferences_input->'muted') e order by 1);
  insert into private.notification_preferences(user_id, muted, updated_at) values (actor_user_id, topics, clock_timestamp())
    on conflict (user_id) do update set muted = excluded.muted, updated_at = excluded.updated_at;
  return jsonb_build_object('muted', to_jsonb(topics));
end; $$;

revoke all on function private.notification_topic(text,text), private.notification_enqueue(text,bigint,text,uuid[],jsonb),
  public.notification_preferences_read(uuid), public.notification_preferences_save(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.notification_preferences_read(uuid), public.notification_preferences_save(uuid,jsonb) to service_role;
