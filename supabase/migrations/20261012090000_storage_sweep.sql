-- T51b: storage cleanup worker. Owner proof photos are removed 30 days after their review decision, and
-- objects nothing references (an upload whose commit was uncertain, a photo a failed cleanup left
-- behind, files of a deleted venue or Auth user) are removed after a 24-hour grace. Supabase refuses
-- direct deletes from storage.objects, so SQL only chooses what is due and records what is gone; the
-- storage-sweep function removes the objects through the Storage API. See docs/privacy.md.

-- Set once the object is really gone; the path stays as the record's reference.
alter table private.venue_claims add column evidence_purged_at timestamptz,
  add constraint venue_claims_evidence_purged check (evidence_purged_at is null or reviewed_at is not null);
alter table private.venue_submissions add column evidence_purged_at timestamptz,
  add constraint venue_submissions_evidence_purged check (evidence_purged_at is null or reviewed_at is not null);

-- What is due at at_time, only in the three app buckets. Evidence: decided 30 days ago and not yet
-- purged. Unreferenced: older than 24 hours (every upload commits within seconds under a fresh random
-- name, so nothing in flight is that old) and not named by a claim or submission that still keeps its
-- evidence, a venue photo or a profile avatar. Objects of unknown age are never due.
create function private.storage_sweep_candidates(at_time timestamptz) returns table (bucket text, path text, reason text)
language sql stable security definer set search_path = '' as $$
  select 'owner-evidence', c.evidence_path, 'evidence_retention' from private.venue_claims c
    where c.evidence_purged_at is null and c.reviewed_at <= at_time - interval '30 days'
  union all
  select 'owner-evidence', s.evidence_path, 'evidence_retention' from private.venue_submissions s
    where s.evidence_purged_at is null and s.reviewed_at <= at_time - interval '30 days'
  union all
  select o.bucket_id, o.name, 'unreferenced' from storage.objects o
    where o.bucket_id = 'owner-evidence' and o.created_at <= at_time - interval '24 hours'
      and not exists (select 1 from private.venue_claims c where c.evidence_path = o.name and c.evidence_purged_at is null)
      and not exists (select 1 from private.venue_submissions s where s.evidence_path = o.name and s.evidence_purged_at is null)
  union all
  select o.bucket_id, o.name, 'unreferenced' from storage.objects o
    where o.bucket_id = 'venue-photos' and o.created_at <= at_time - interval '24 hours'
      and not exists (select 1 from public.venue_photos p where p.storage_path = o.name)
  union all
  select o.bucket_id, o.name, 'unreferenced' from storage.objects o
    where o.bucket_id = 'avatars' and o.created_at <= at_time - interval '24 hours'
      and not exists (select 1 from public.profiles p where p.avatar_path = o.name);
$$;

-- One batch for the worker, evidence first. Overlapping runs may get the same items; removing a missing
-- object is a no-op and confirmation records each purge once.
create function public.storage_sweep_due(batch_limit integer default 200) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz := clock_timestamp(); items jsonb;
begin
  if batch_limit is null or batch_limit not between 1 and 1000 then
    raise exception 'Invalid batch' using errcode = '22023', hint = 'invalid_input';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('bucket', c.bucket, 'path', c.path, 'reason', c.reason)
      order by c.reason, c.bucket, c.path), '[]'::jsonb)
    into items from (select * from private.storage_sweep_candidates(at_time) d order by d.reason, d.bucket, d.path limit batch_limit + 1) c;
  return jsonb_build_object('at', at_time, 'items', case when jsonb_array_length(items) > batch_limit then items - batch_limit else items end,
    'more', jsonb_array_length(items) > batch_limit);
end; $$;

-- After the worker asked Storage to remove a batch: objects still present are only counted (the next
-- run retries them), and due evidence whose object is really gone is recorded as purged, once.
create function public.storage_sweep_confirm(items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare at_time timestamptz := clock_timestamp(); remaining integer; claims integer; submissions integer;
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) > 1000
    or exists (select 1 from jsonb_array_elements(items) e
      where jsonb_typeof(e) <> 'object' or (select count(*) from jsonb_object_keys(e)) <> 3
        or coalesce(e->>'bucket', '') not in ('owner-evidence','venue-photos','avatars')
        or coalesce(e->>'reason', '') not in ('evidence_retention','unreferenced')
        or coalesce(jsonb_typeof(e->'path'), '') <> 'string' or char_length(e->>'path') not between 1 and 1024) then
    raise exception 'Invalid items' using errcode = '22023', hint = 'invalid_input';
  end if;
  select count(*) into remaining from jsonb_array_elements(items) e
    where exists (select 1 from storage.objects o where o.bucket_id = e->>'bucket' and o.name = e->>'path');
  update private.venue_claims c set evidence_purged_at = at_time
    where c.evidence_purged_at is null and c.reviewed_at <= at_time - interval '30 days'
      and c.evidence_path in (select e->>'path' from jsonb_array_elements(items) e where e->>'bucket' = 'owner-evidence')
      and not exists (select 1 from storage.objects o where o.bucket_id = 'owner-evidence' and o.name = c.evidence_path);
  get diagnostics claims = row_count;
  update private.venue_submissions s set evidence_purged_at = at_time
    where s.evidence_purged_at is null and s.reviewed_at <= at_time - interval '30 days'
      and s.evidence_path in (select e->>'path' from jsonb_array_elements(items) e where e->>'bucket' = 'owner-evidence')
      and not exists (select 1 from storage.objects o where o.bucket_id = 'owner-evidence' and o.name = s.evidence_path);
  get diagnostics submissions = row_count;
  return jsonb_build_object('purged', claims + submissions, 'remaining', remaining);
end; $$;

-- Reviewers: a purged proof photo is reported as removed, not as missing or broken.
create or replace function public.ownership_review_evidence(actor_user_id uuid, subject_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare evidence text; purged timestamptz;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  select c.evidence_path, c.evidence_purged_at into evidence, purged from private.venue_claims c where c.id = subject_id;
  if evidence is null then
    select s.evidence_path, s.evidence_purged_at into evidence, purged from private.venue_submissions s where s.id = subject_id;
  end if;
  if evidence is null then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  if purged is not null then raise exception 'Evidence removed after review' using errcode = 'P0002', hint = 'evidence_removed'; end if;
  return evidence;
end;
$$;

create or replace function public.ownership_review_read(actor_user_id uuid, subject_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare item jsonb;
begin
  perform private.require_ownership_reviewer(actor_user_id);
  item := private.ownership_review_item(subject_id);
  if item is null then raise exception 'Review item not found' using errcode = 'P0002', hint = 'not_found'; end if;
  return item || jsonb_build_object('evidence_removed_at', coalesce(
    (select c.evidence_purged_at from private.venue_claims c where c.id = subject_id),
    (select s.evidence_purged_at from private.venue_submissions s where s.id = subject_id)));
end;
$$;

-- pg_cron caller, like ops_monitor_kick: posts to the storage-sweep function with the Vault secrets.
create function private.storage_sweep_kick() returns bigint
language plpgsql security definer set search_path = '' as $$
declare target text; secret text;
begin
  select s.decrypted_secret into target from vault.decrypted_secrets s where s.name = 'storage_sweep_url';
  select s.decrypted_secret into secret from vault.decrypted_secrets s where s.name = 'storage_sweep_secret';
  if target is null or secret is null then
    raise exception 'Storage sweep is not configured' using errcode = '55000', hint = 'not_configured';
  end if;
  return net.http_post(url := target, body := '{}'::jsonb, timeout_milliseconds := 60000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || secret));
end; $$;

-- Idempotent: pg_cron updates the named job. Daily at 03:47 Manila, after the privacy retention sweep.
-- Run only after the Vault secrets exist.
create function private.storage_sweep_schedule() returns bigint
language plpgsql set search_path = '' as $$
begin
  return cron.schedule('storage-sweep', '47 19 * * *', 'select private.storage_sweep_kick()');
end; $$;

-- The monitor: storage-sweep reports Edge signals like the other functions.
alter table private.ops_signals drop constraint ops_signals_source_check,
  add constraint ops_signals_source_check check (source in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
    'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch','storage-sweep'));

create or replace function public.ops_signal_record(signal_source text, signal_kind text, occurrences integer) returns void
language plpgsql security definer set search_path='' as $$
begin
  if signal_source is null or signal_source not in ('venue-search','owner-submissions','owner-venues','owner-schedules','rental-bookings',
      'owner-sessions','session-bookings','venue-reports','account-deletion','push-devices','push-dispatch','storage-sweep')
    or signal_kind is null or signal_kind not in ('server_error','unavailable','limiter_degraded')
    or occurrences is null or occurrences not between 1 and 10000 then
    raise exception 'Invalid signal' using errcode='22023', hint='invalid_input';
  end if;
  insert into private.ops_signals(minute, source, kind, occurrences)
    values (date_trunc('minute', clock_timestamp()), signal_source, signal_kind, occurrences)
  on conflict (minute, source, kind) do update set occurrences = least(private.ops_signals.occurrences + excluded.occurrences, 1000000);
end; $$;

-- T51a's checks, plus the storage-sweep job among the expected ones and a storage.backlog check.
create or replace function private.ops_health(at_time timestamptz) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
  checks jsonb := '[]'::jsonb;
  expected text[] := array['booking-expiry-sweep','push-dispatch','privacy-retention-sweep','ops-monitor','storage-sweep'];
  n bigint; credentials bigint;
begin
  -- Scheduled jobs: present and active; recent failed runs; every-minute jobs with no recent success.
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    checks := checks || private.ops_check('cron.jobs', cardinality(expected), 1, 1);
  else
    select count(*) into n from unnest(expected) j(name)
      where not exists (select 1 from cron.job c where c.jobname = j.name and c.active);
    checks := checks || private.ops_check('cron.jobs', n, 1, 1);
    select count(*) into n from cron.job_run_details d join cron.job c on c.jobid = d.jobid
      where c.jobname = any(expected) and d.status = 'failed' and d.start_time > at_time - interval '15 minutes';
    checks := checks || private.ops_check('cron.failures', n, 1, 3);
    select count(*) into n from cron.job c
      where c.jobname in ('booking-expiry-sweep','push-dispatch') and c.active
        and not exists (select 1 from cron.job_run_details d where d.jobid = c.jobid and d.status = 'succeeded'
          and d.start_time > at_time - interval '10 minutes');
    checks := checks || private.ops_check('cron.stalled', n, 1, 1);
  end if;

  -- Holds the every-minute sweep should have recorded as expired by now. Reads already treat them as
  -- expired, so this means the sweep is not running, not that inventory is wrong.
  select (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
      where b.status = 'pending' and a.expires_at <= at_time - interval '10 minutes')
    + (select count(*) from private.session_bookings b where b.status = 'pending' and b.expires_at <= at_time - interval '10 minutes')
    into n;
  checks := checks || private.ops_check('holds.overdue', n, 1, 1);

  -- Inventory that disagrees with bookings: a confirmed rental without its firm court, a finished one
  -- still holding it, rental or session inventory with no owner, a session counter that differs from its
  -- live groups, or session courts out of step with the session. Recent and upcoming rows only.
  select (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
      where a.ends_at > at_time - interval '2 days' and (
        (b.status = 'confirmed' and (a.state <> 'active' or a.expires_at is not null))
        or (b.status = 'pending' and a.state = 'released')
        or (b.status in ('declined','cancelled','expired') and a.state = 'active' and (a.expires_at is null or a.expires_at > at_time))))
    + (select count(*) from private.court_allocations a where a.ends_at > at_time - interval '2 days' and a.state = 'active'
        and ((a.kind = 'rental' and not exists (select 1 from private.rental_bookings b where b.id = a.id))
          or (a.kind = 'session' and not exists (select 1 from private.session_courts sc where sc.allocation_id = a.id))))
    + (select count(*) from private.open_play_sessions s where s.ends_at > at_time - interval '2 days' and (
        s.reserved_spots <> coalesce((select sum(b.spots) from private.session_bookings b
          where b.session_id = s.id and b.status in ('pending','confirmed')), 0)
        or exists (select 1 from private.session_courts sc join private.court_allocations a on a.id = sc.allocation_id
          where sc.session_id = s.id and (s.status = 'scheduled') <> (a.state = 'active' and a.expires_at is null))))
    into n;
  checks := checks || private.ops_check('inventory.mismatch', n, 1, 1);

  -- Push: rows the worker should have taken by now, and rows or receipts that failed in the last hours.
  select count(*) into n from private.notification_outbox o
    where (o.status = 'pending' and o.next_attempt_at <= at_time - interval '10 minutes')
      or (o.status = 'sending' and o.locked_until <= at_time - interval '10 minutes');
  checks := checks || private.ops_check('push.backlog', n, 1, 1);
  -- Credential/sender errors fail every later push too (APNs key or Expo access token), so one is enough.
  select count(*) filter (where o.last_error is null or o.last_error not in ('invalid_credentials','mismatch_sender_id','expo_rejected')),
      count(*) filter (where o.last_error in ('invalid_credentials','mismatch_sender_id','expo_rejected'))
    into n, credentials from private.notification_outbox o
    where o.status = 'failed' and o.finished_at > at_time - interval '1 hour';
  n := n + (select count(*) from private.push_deliveries p where p.receipt = 'error' and p.receipt_error is distinct from 'device_not_registered'
    and p.sent_at > at_time - interval '2 hours');
  checks := checks || private.ops_check('push.failures', n, 1, 10) || private.ops_check('push.credentials', credentials, 1, 1);

  -- Edge function answers recorded through ops_signal_record during the last 15 minutes.
  select coalesce(sum(s.occurrences) filter (where s.kind = 'server_error'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.errors', n, 1, 5);
  select coalesce(sum(s.occurrences) filter (where s.kind = 'unavailable'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.unavailable', n, 5, 25);
  select coalesce(sum(s.occurrences) filter (where s.kind = 'limiter_degraded'), 0) into n from private.ops_signals s
    where s.minute > at_time - interval '15 minutes';
  checks := checks || private.ops_check('edge.limiter', n, 1, 1);

  -- Account deletions that started over an hour ago and still have an Auth user (storage or Auth step failed).
  select count(*) into n from private.account_deletions d
    where d.requested_at <= at_time - interval '1 hour' and exists (select 1 from auth.users u where u.id = d.user_id);
  checks := checks || private.ops_check('privacy.deletions', n, 1, 1);

  -- Files the daily storage sweep should have removed over a day ago: it is not running, or Storage
  -- keeps refusing them. The whole of the three buckets is checked, which is fine at pilot scale.
  select count(*) into n from private.storage_sweep_candidates(at_time - interval '1 day');
  checks := checks || private.ops_check('storage.backlog', n, 1, 25);

  -- The pilot is pay-on-arrival only (user decision 2026-10-10): no merchant, stored online policy or live
  -- booking snapshot may offer online payment. Replace this check when online payments resume.
  select (select count(*) from private.venue_merchants m where m.active)
    + (select count(*) from private.venue_policies p where p.payment <> 'arrival')
    + (select count(*) from private.rental_bookings b join private.court_allocations a on a.id = b.id
        join private.rental_snapshots s on s.allocation_id = b.id
        where b.status in ('pending','confirmed') and a.ends_at > at_time and s.snapshot->'policy'->>'payment' is distinct from 'arrival')
    + (select count(*) from private.open_play_sessions s
        where s.status = 'scheduled' and s.ends_at > at_time and s.snapshot->'policy'->>'payment' is distinct from 'arrival')
    into n;
  checks := checks || private.ops_check('rollout.arrival_only', n, 1, 1);
  return checks;
end; $$;

revoke all on function private.storage_sweep_candidates(timestamptz), public.storage_sweep_due(integer), public.storage_sweep_confirm(jsonb),
  private.storage_sweep_kick(), private.storage_sweep_schedule() from public, anon, authenticated, service_role;
grant execute on function public.storage_sweep_due(integer), public.storage_sweep_confirm(jsonb) to service_role;
notify pgrst, 'reload schema';
