-- Rollback-only fixtures for T54 pre-launch claims: grants, the code check, the per-account lockout, redemption
-- into the claimant's pending submission on the registration's draft, retries, used/erased/suspended/verified
-- codes, the T15 caps and evidence rules, the deletion guard, review markers and contacts, and the privacy sweep.
-- Runs on PGlite (with an auth.users email column) and Docker.
begin;
create schema pc_test;
create function pc_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Claim assertion failed: %', message; end if; end; $$;
-- Runs one command and returns its jsonb result, or {"error": hint} when it raises (its writes roll back).
create function pc_test.call(statement text) returns jsonb language plpgsql as $$
declare result jsonb; hint text;
begin
  execute statement into result;
  return result;
exception when others then
  get stacked diagnostics hint = pg_exception_hint;
  return jsonb_build_object('error', coalesce(nullif(hint, ''), sqlstate));
end; $$;
create function pc_test.u(n text) returns uuid language sql immutable as $$ select ('c5100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function pc_test.k(n integer) returns uuid language sql immutable as $$ select ('c5300000-0000-4000-8000-'||lpad(n::text, 12, '0'))::uuid; $$;
create function pc_test.h(n integer) returns text language sql immutable as $$ select md5('claim-test-'||n)||md5('claim-test-code-'||n); $$;
create function pc_test.ev(who uuid, n integer) returns text language sql immutable as $$
  select who::text||'/c5400000-0000-4000-8000-'||lpad(n::text, 12, '0')||'.jpg'; $$;
create function pc_test.body(email text, venue_name text, lat double precision, lng double precision) returns jsonb language sql immutable as $$
  select jsonb_build_object('owner_name', 'Ana Cruz', 'email', email, 'phone', '+639171234567', 'role', 'manager',
    'venue', jsonb_build_object('name', venue_name, 'address_line', '12 Mabini St', 'city', 'Claimtown',
      'province', 'Metro Manila', 'latitude', lat, 'longitude', lng, 'court_count', 4),
    'courts', jsonb_build_object('indoor', false, 'covered', true, 'surface', null),
    'note', 'Gate on Mabini St.', 'consent', true); $$;
create function pc_test.check(actor uuid, code integer) returns jsonb language sql as $$
  select pc_test.call(format('select public.owner_registration_check(%L, %L)', actor, pc_test.h(code))); $$;
create function pc_test.redeem(actor uuid, key integer, code integer, evidence text, note text default null) returns jsonb language sql as $$
  select pc_test.call(format('select public.owner_redeem_registration(%L, %L, %L, %L, %L)', actor, pc_test.k(key), pc_test.h(code), evidence, note)); $$;
-- Fixture readers run as the test owner, so assertions may use them under any role.
create function pc_test.failures(actor uuid) returns integer language sql security definer as $$
  select coalesce((select f.failures from private.claim_code_failures f where f.user_id = actor), 0); $$;
create function pc_test.reg(key integer) returns private.venue_registrations language sql security definer as $$
  select r.* from private.venue_registrations r where r.request_key = pc_test.k(key); $$;
-- Statements expected to fail: returns the SQLSTATE, or null when the statement succeeded.
create function pc_test.fails(statement text) returns text language plpgsql as $$
begin
  execute statement;
  return null;
exception when others then return sqlstate;
end; $$;
grant usage on schema pc_test to anon, authenticated, service_role;
grant execute on all functions in schema pc_test to anon, authenticated, service_role;

-- Only the owner-submissions server (service_role) runs the two commands; nobody touches the lockout table.
select pc_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname in ('public','private') and p.proname in ('owner_registration_check','owner_redeem_registration','claim_code_fail',
    'claim_code_lock_seconds','claim_code_refusal','registration_review') and has_function_privilege(r.name, p.oid, 'execute')),
  'no client role runs claim commands');
select pc_test.assert_that(has_function_privilege('service_role', 'public.owner_registration_check(uuid,text)', 'execute')
  and has_function_privilege('service_role', 'public.owner_redeem_registration(uuid,uuid,text,text,text)', 'execute')
  and not has_function_privilege('service_role', 'private.claim_code_fail(uuid,timestamptz)', 'execute')
  and not has_function_privilege('service_role', 'private.registration_review(uuid)', 'execute'), 'service role grants');
select pc_test.assert_that(not exists(select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(name)
  cross join (values ('select'), ('insert'), ('update'), ('delete')) p(privilege)
  where has_table_privilege(r.name, 'private.claim_code_failures', p.privilege)), 'no role touches the lockout table');
select pc_test.assert_that((select relrowsecurity from pg_class where oid = 'private.claim_code_failures'::regclass), 'lockout RLS enabled');

-- Accounts: admin (1), moderator (2), claimant whose email matches (3), another claimant (4), lockout (5),
-- five pending submissions (6), deletion in progress (7). One approved listing beside registration 1.
insert into auth.users(id, email) values (pc_test.u('1'), 'admin@example.ph'), (pc_test.u('2'), 'mod@example.ph'),
  (pc_test.u('3'), 'Ana@Example.PH'), (pc_test.u('4'), 'bob.other@example.ph'), (pc_test.u('5'), 'lock@example.ph'),
  (pc_test.u('6'), 'cap@example.ph'), (pc_test.u('7'), 'leaving@example.ph');
insert into private.account_roles(user_id, role) values (pc_test.u('1'), 'admin'), (pc_test.u('2'), 'moderator');
insert into public.venues(id, name, address_line, city, province, latitude, longitude, publication_status)
  values ('c5200000-0000-4000-8000-000000000001', 'Approved Claim Fixture', '10 Mabini St', 'Claimtown', 'Metro Manila', 14.5500, 121.0200, 'approved');
insert into public.courts(venue_id, name) values ('c5200000-0000-4000-8000-000000000001', 'Court 1');
insert into storage.objects(bucket_id, name)
  select 'owner-evidence', pc_test.ev(pc_test.u(n::text), e) from generate_series(1, 7) n, generate_series(1, 8) e;

-- Registrations (T53 command): 1 next to the approved listing, 2 elsewhere, 3 suspended, 4 erased, 5 verified,
-- 6 near another of the claimant's submissions, 7 left open.
set local role service_role;
select pc_test.assert_that(bool_and(public.prelaunch_register(pc_test.k(n), pc_test.body(e, nm, lat, lng), pc_test.h(n), true)->>'outcome' = 'created'),
  'registrations created') from (values (1, 'ana@example.ph', 'Claimable Courts', 14.5501, 121.0201), (2, 'bob@example.ph', 'Second Courts', 10.30, 123.90),
  (3, 'ana@example.ph', 'Suspended Courts', 7.07, 125.61), (4, 'ana@example.ph', 'Erased Courts', 16.41, 120.59),
  (5, 'ana@example.ph', 'Verified Courts', 9.30, 123.30), (6, 'ana@example.ph', 'Pending Twin Courts', 13.62, 123.18),
  (7, 'cy@example.ph', 'Open Courts', 15.00, 120.60)) r(n, e, nm, lat, lng);
reset role;
create temporary table drafts on commit drop as select r.request_key, r.venue_id from private.venue_registrations r;
create function pc_test.draft(key integer) returns uuid language sql security definer as $$ select venue_id from drafts where request_key = pc_test.k(key); $$;
update public.venues set publication_status = 'suspended' where id = pc_test.draft(3);
update public.venues set publication_status = 'approved', claim_status = 'verified' where id = pc_test.draft(5);
update private.venue_registrations set email_sent_at = clock_timestamp() - interval '181 days' where request_key = pc_test.k(4);
select pc_test.assert_that((select r->>'prelaunch_registrations' = '1' from private.privacy_retention_sweep(500) r), 'registration 4 erased');

set local role service_role;
-- Validation and accounts.
select pc_test.assert_that(pc_test.call(format('select public.owner_registration_check(%L, %L)', pc_test.u('3'), 'not-a-hash'))->>'error' = 'invalid_input', 'bad hash');
select pc_test.assert_that(pc_test.call(format('select public.owner_registration_check(%L, %L)', pc_test.u('3'), upper(pc_test.h(1))))->>'error' = 'invalid_input', 'uppercase hash');
select pc_test.assert_that(pc_test.call(format('select public.owner_redeem_registration(%L, null, %L, %L, null)', pc_test.u('3'), pc_test.h(1), pc_test.ev(pc_test.u('3'), 1)))->>'error' = 'invalid_input', 'no request id');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 9, 1, pc_test.ev(pc_test.u('3'), 1), ' padded')->>'error' = 'invalid_input', 'bad note');
select pc_test.assert_that(pc_test.check('c5100000-0000-4000-8000-000000000099', 1)->>'error' = 'actor_required', 'unknown account');

-- A right code shows the venue it names; nothing is counted.
select pc_test.assert_that((select r->>'outcome' = 'valid' and r->'retry_after_seconds' = 'null'::jsonb
  and r->'registration' = '{"name": "Claimable Courts", "address_line": "12 Mabini St", "city": "Claimtown", "province": "Metro Manila", "court_count": 4}'::jsonb
  from pc_test.check(pc_test.u('3'), 1) r), 'valid check shows the venue');
select pc_test.assert_that(pc_test.failures(pc_test.u('3')) = 0, 'a right code counts nothing');

-- Lockout: wrong codes from checks and redemptions count; the fifth within an hour locks, even right codes.
select pc_test.assert_that(bool_and(r->>'outcome' = 'invalid' and r->'retry_after_seconds' = 'null'::jsonb and r->'registration' = 'null'::jsonb), 'four wrong checks')
  from (select pc_test.check(pc_test.u('5'), 90 + n) r from generate_series(0, 3) n) x;
select pc_test.assert_that(pc_test.failures(pc_test.u('5')) = 4, 'four counted');
select pc_test.assert_that((select r->>'outcome' = 'locked' and (r->>'retry_after_seconds')::int between 3590 and 3600 and r->'submission' = 'null'::jsonb
  from pc_test.redeem(pc_test.u('5'), 50, 94, pc_test.ev(pc_test.u('5'), 1)) r), 'fifth wrong try (a redemption) locks');
select pc_test.assert_that((select r->>'outcome' = 'locked' and r->'registration' = 'null'::jsonb from pc_test.check(pc_test.u('5'), 1) r), 'locked check, right code');
select pc_test.assert_that((select r->>'outcome' = 'locked' from pc_test.redeem(pc_test.u('5'), 51, 1, pc_test.ev(pc_test.u('5'), 2)) r), 'locked redemption, right code');
reset role;
select pc_test.assert_that((select status = 'open' and code_hash = pc_test.h(1) from pc_test.reg(1)) and pc_test.failures(pc_test.u('5')) = 5
  and not exists (select 1 from private.venue_submissions where submitter_user_id = pc_test.u('5')), 'nothing written while locked');
-- After the lock, counting starts again; so does it once the window has passed.
update private.claim_code_failures set locked_until = clock_timestamp() - interval '1 second', window_started_at = clock_timestamp() - interval '61 minutes'
  where user_id = pc_test.u('5');
set local role service_role;
select pc_test.assert_that(pc_test.check(pc_test.u('5'), 95)->>'outcome' = 'invalid', 'lock over');
reset role;
select pc_test.assert_that(pc_test.failures(pc_test.u('5')) = 1, 'count restarted after the lock');
update private.claim_code_failures set failures = 4, window_started_at = clock_timestamp() - interval '61 minutes' where user_id = pc_test.u('5');
set local role service_role;
select pc_test.assert_that(pc_test.check(pc_test.u('5'), 96)->>'outcome' = 'invalid', 'old failures expire');
reset role;
select pc_test.assert_that(pc_test.failures(pc_test.u('5')) = 1 and (select locked_until is null from private.claim_code_failures where user_id = pc_test.u('5')),
  'an old window never locks');

-- Redemption: the registration's draft becomes the claimant's pending submission in one audited transaction.
set local role service_role;
select pc_test.assert_that(pc_test.check(pc_test.u('3'), 97)->>'outcome' = 'invalid', 'one wrong try first');
create temporary table first_claim on commit drop as select pc_test.redeem(pc_test.u('3'), 10, 1, pc_test.ev(pc_test.u('3'), 1), 'Owner of the hall') r;
reset role;
select pc_test.assert_that((select r->>'outcome' = 'created' and r->'submission'->>'kind' = 'venue' and r->'submission'->>'status' = 'pending'
  and r->'submission'->>'venue_id' = pc_test.draft(1)::text and r->'submission'->>'name' = 'Claimable Courts' from first_claim), 'created result');
create temporary table first_sub on commit drop as
  select s.* from private.venue_submissions s where s.id = (select (r->'submission'->>'id')::uuid from first_claim);
grant select on first_sub to service_role, authenticated;
select pc_test.assert_that((select s.submitter_user_id = pc_test.u('3') and s.request_id = pc_test.k(10) and s.venue_id = pc_test.draft(1)
  and s.name = 'Claimable Courts' and s.address_line = '12 Mabini St' and s.city = 'Claimtown' and s.latitude = 14.5501 and s.court_count = 4
  and s.evidence_path = pc_test.ev(pc_test.u('3'), 1) and s.note = 'Owner of the hall' and s.duplicates_acknowledged and s.status = 'pending'
  from first_sub s), 'submission fields from the draft');
select pc_test.assert_that((select 'c5200000-0000-4000-8000-000000000001'::uuid = any(s.nearby_venue_ids) and not (s.venue_id = any(s.nearby_venue_ids))
  from first_sub s), 'reviewer snapshot names the approved neighbour, never the draft itself');
select pc_test.assert_that((select v.publication_status = 'draft' and v.claim_status = 'pending' from public.venues v where v.id = pc_test.draft(1)), 'draft now under review');
select pc_test.assert_that((select r.status = 'claimed' and r.code_hash is null and r.claimed_by = pc_test.u('3') and r.claimed_at is not null
  and r.submission_id = (select id from first_sub) and r.claim_email_matched and r.owner_name = 'Ana Cruz' from pc_test.reg(1) r), 'registration claimed, code spent');
select pc_test.assert_that((select count(*) = 1 and bool_and(e.actor_user_id = pc_test.u('3') and e.target_venue_id = pc_test.draft(1))
  from private.ownership_audit_events e where e.subject_id = (select id from first_sub) and e.action = 'registration.claim'), 'one claim audit row');
select pc_test.assert_that(pc_test.failures(pc_test.u('3')) = 0, 'a redemption clears the wrong-code count');
select pc_test.assert_that(private.is_pending_venue_creator(pc_test.u('3'), pc_test.draft(1)) and private.is_venue_editor(pc_test.u('3'), pc_test.draft(1))
  and not exists (select 1 from private.venue_owners o where o.venue_id = pc_test.draft(1)), 'pending creator, no owner link');
set local role service_role;
select pc_test.assert_that((select bool_or(x->>'id' = pc_test.draft(1)::text and (x->>'editable')::boolean)
  from jsonb_array_elements(public.owner_venue_list(pc_test.u('3'))) x), 'the claimant sets the draft up');
reset role;
select set_config('request.jwt.claims', '{"sub":"c5100000-0000-4000-8000-000000000003","role":"authenticated"}', true);
set local role authenticated;
select pc_test.assert_that((select pending_venue_ids = array[pc_test.draft(1)] and owned_venue_ids = '{}' from public.my_account_access()), 'pending venue access');
select pc_test.assert_that((select count(*) = 1 and bool_and(m.kind = 'venue' and m.status = 'pending' and m.venue_id = pc_test.draft(1))
  from public.my_owner_submissions() m), 'listed in the claimant''s submissions');
reset role;

-- A retry after a lost reply returns the original although the code is spent; other accounts can't reuse it.
set local role service_role;
select pc_test.assert_that((select r->>'outcome' = 'existing' and r->'submission'->>'id' = (select id::text from first_sub)
  from pc_test.redeem(pc_test.u('3'), 10, 1, pc_test.ev(pc_test.u('3'), 2), 'Owner of the hall') r), 'retry returns the original');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 10, 99, pc_test.ev(pc_test.u('3'), 2))->>'outcome' = 'existing', 'retry needs no live code');
select pc_test.assert_that(pc_test.check(pc_test.u('4'), 1)->>'outcome' = 'invalid', 'a used code checks as invalid');
select pc_test.assert_that(pc_test.redeem(pc_test.u('4'), 20, 1, pc_test.ev(pc_test.u('4'), 1))->>'outcome' = 'invalid', 'a used code redeems as invalid');
reset role;
select pc_test.assert_that((select count(*) = 1 from private.venue_submissions where submitter_user_id = pc_test.u('3'))
  and (select count(*) = 1 from private.ownership_audit_events where action = 'registration.claim')
  and pc_test.failures(pc_test.u('4')) = 2 and pc_test.failures(pc_test.u('3')) = 0, 'one submission; used-code tries counted');

-- Erased, suspended and verified registrations; the T15 caps, evidence rules and the deletion guard.
set local role service_role;
select pc_test.assert_that(pc_test.check(pc_test.u('3'), 4)->>'outcome' = 'invalid', 'an erased code is invalid');
select pc_test.assert_that(pc_test.check(pc_test.u('3'), 3)->>'error' = 'listing_unavailable', 'suspended listing (check)');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 11, 3, pc_test.ev(pc_test.u('3'), 3))->>'error' = 'listing_unavailable', 'suspended listing (redeem)');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 12, 5, pc_test.ev(pc_test.u('3'), 4))->>'error' = 'already_verified', 'verified listing');
select pc_test.assert_that((select r->>'outcome' = 'created' from pc_test.call(format('select public.owner_submit_venue(%L, %L, %L, %L, null, true)',
  pc_test.u('3'), pc_test.k(13), jsonb_build_object('name', 'App Twin', 'address_line', '1 Rizal Ave', 'city', 'Claimtown', 'province', 'Albay',
    'latitude', 13.6202, 'longitude', 123.1802, 'court_count', 2), pc_test.ev(pc_test.u('3'), 5))) r), 'an app submission beside registration 6');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 14, 6, pc_test.ev(pc_test.u('3'), 6))->>'error' = 'already_pending', 'already pending within 150 m');
select pc_test.assert_that(pc_test.redeem(pc_test.u('3'), 13, 6, pc_test.ev(pc_test.u('3'), 6))->>'error' = 'request_reused', 'request id of another submission');
select pc_test.assert_that(pc_test.redeem(pc_test.u('4'), 21, 2, pc_test.ev(pc_test.u('4'), 99))->>'error' = 'invalid_evidence', 'evidence never uploaded');
select pc_test.assert_that(pc_test.redeem(pc_test.u('4'), 22, 2, pc_test.ev(pc_test.u('3'), 1))->>'error' = 'invalid_evidence', 'someone else''s evidence');
select pc_test.assert_that(bool_and(pc_test.call(format('select public.owner_submit_venue(%L, %L, %L, %L, null, true)', pc_test.u('6'), pc_test.k(60 + n),
  jsonb_build_object('name', 'Cap '||n, 'address_line', '2 Luna St', 'city', 'Captown', 'province', 'Sulu', 'latitude', 5.1 + n * 0.1,
    'longitude', 120.0, 'court_count', 1), pc_test.ev(pc_test.u('6'), n)))->>'outcome' = 'created'), 'five pending') from generate_series(1, 5) n;
select pc_test.assert_that(pc_test.redeem(pc_test.u('6'), 30, 7, pc_test.ev(pc_test.u('6'), 6))->>'error' = 'too_many_pending', 'pending cap');
reset role;
insert into private.account_deletions(user_id) values (pc_test.u('7'));
set local role service_role;
select pc_test.assert_that(pc_test.redeem(pc_test.u('7'), 40, 7, pc_test.ev(pc_test.u('7'), 1))->>'error' = 'account_deleted', 'deletion in progress');
-- A claimant whose account email differs still claims; reviewers see that it didn't match.
select pc_test.assert_that(pc_test.redeem(pc_test.u('4'), 23, 2, pc_test.ev(pc_test.u('4'), 2))->>'outcome' = 'created', 'second claim');
reset role;
select pc_test.assert_that((select status = 'open' and code_hash = pc_test.h(7) from pc_test.reg(7)) and (select status = 'open' from pc_test.reg(3))
  and (select status = 'open' from pc_test.reg(5)) and (select status = 'open' from pc_test.reg(6)), 'refusals left registrations open');
select pc_test.assert_that((select r.status = 'claimed' and r.claimed_by = pc_test.u('4') and not r.claim_email_matched from pc_test.reg(2) r)
  and pc_test.failures(pc_test.u('4')) = 0 and pc_test.failures(pc_test.u('6')) = 0 and pc_test.failures(pc_test.u('7')) = 0, 'mismatch recorded; refusals uncounted');

-- Reviewers: a pre-launch marker in the queue; role, times and email match for everyone; contacts for admins only.
create temporary table prelaunch_subs on commit drop as select submission_id as id from private.venue_registrations where status = 'claimed';
create temporary table app_sub on commit drop as select id from private.venue_submissions where request_id = pc_test.k(13);
grant select on prelaunch_subs, app_sub to service_role;
set local role service_role;
select pc_test.assert_that((select bool_and((x->>'prelaunch')::boolean = ((x->>'id')::uuid in (select id from prelaunch_subs)))
  and count(*) filter (where (x->>'prelaunch')::boolean) = 2 and count(*) = 8
  from jsonb_array_elements(public.ownership_review_queue(pc_test.u('1'))->'items') x), 'queue marks pre-launch items');
select pc_test.assert_that((select r->'registration'->>'role' = 'manager' and (r->'registration'->>'email_matched')::boolean
  and not (r->'registration'->>'erased')::boolean and r->'registration'->>'claimed_at' is not null
  and r->'registration'->'contact' = '{"owner_name": "Ana Cruz", "email": "ana@example.ph", "phone": "+639171234567", "note": "Gate on Mabini St."}'::jsonb
  from public.ownership_review_read(pc_test.u('1'), (select id from first_sub)) r), 'admin sees the registration and contacts');
select pc_test.assert_that((select r->'registration'->>'role' = 'manager' and r->'registration'->'contact' = 'null'::jsonb
  and r::text not like '%ana@example.ph%' and r::text not like '%+639171234567%'
  from public.ownership_review_read(pc_test.u('2'), (select id from first_sub)) r), 'moderator sees no contacts');
select pc_test.assert_that((select r->'registration' = 'null'::jsonb from public.ownership_review_read(pc_test.u('1'),
  (select id from app_sub)) r), 'app submissions have no registration');
-- Approval publishes the draft and links the claimant, as for app-created venues.
select pc_test.assert_that(public.ownership_review_decide(pc_test.u('1'), (select id from first_sub), 'approve', null, null)->>'outcome' = 'decided', 'approved');
reset role;
select pc_test.assert_that((select v.publication_status = 'approved' and v.claim_status = 'verified' from public.venues v where v.id = pc_test.draft(1))
  and exists (select 1 from private.venue_owners o where o.venue_id = pc_test.draft(1) and o.user_id = pc_test.u('3')), 'published and linked');
select pc_test.assert_that(pc_test.fails(format('update private.venue_registrations set code_hash = %L where request_key = %L', pc_test.h(8), pc_test.k(1))) = '23514',
  'claimed rows hold no code');
select pc_test.assert_that(pc_test.fails(format('update private.venue_registrations set claimed_at = now() where request_key = %L', pc_test.k(7))) = '23514', 'open rows hold no claim');
select pc_test.assert_that(pc_test.fails(format('update private.venue_registrations set status = %L where request_key = %L', 'claimed', pc_test.k(7))) = '23514', 'claimed rows need a claim');

-- Privacy sweep: contacts stay while a claim is pending and for 30 days after its decision, then go; a claim
-- whose submission is gone (account deleted) is erased at once.
select pc_test.assert_that((select r->>'prelaunch_registrations' = '0' from private.privacy_retention_sweep(500) r)
  and (select status = 'claimed' from pc_test.reg(1)) and (select status = 'claimed' from pc_test.reg(2)), 'recent and pending claims kept');
update private.venue_submissions set reviewed_at = clock_timestamp() - interval '31 days' where id = (select id from first_sub);
select pc_test.assert_that((select r->>'prelaunch_registrations' = '1' and r->>'more' = 'false' from private.privacy_retention_sweep(500) r), 'one erased');
select pc_test.assert_that((select r.status = 'erased' and r.owner_name is null and r.email is null and r.phone is null and r.note is null
  and r.erased_at is not null and r.claimed_by = pc_test.u('3') and r.submission_id = (select id from first_sub) from pc_test.reg(1) r)
  and (select status = 'claimed' from pc_test.reg(2)), 'decided claim erased, pending claim kept');
set local role service_role;
select pc_test.assert_that((select (r->'registration'->>'erased')::boolean and r->'registration'->'contact' = 'null'::jsonb
  from public.ownership_review_read(pc_test.u('1'), (select id from first_sub)) r), 'reviewers see the erasure');
reset role;
delete from auth.users where id = pc_test.u('4');
select pc_test.assert_that((select r->>'prelaunch_registrations' = '1' from private.privacy_retention_sweep(500) r)
  and (select status = 'erased' and email is null from pc_test.reg(2)), 'claim without a submission erased');
select pc_test.assert_that((select r->>'prelaunch_registrations' = '0' from private.privacy_retention_sweep(500) r), 'sweep idempotent');
rollback;
