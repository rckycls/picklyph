-- Rollback-only fixtures for T54b console registrations: grants, the admin-only list (filters, contacts, paging,
-- counts), code rotation (refusals, the expected version, collisions, audit, the delivered version) and erasure of
-- open, claimed and erased registrations. Runs on PGlite (with an auth.users email column) and Docker.
begin;
create schema pa_test;
create function pa_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Registration admin assertion failed: %', message; end if; end; $$;
-- Runs one command and returns its jsonb result, or {"error": hint} when it raises (its writes roll back).
create function pa_test.call(statement text) returns jsonb language plpgsql as $$
declare result jsonb; hint text;
begin
  execute statement into result;
  return result;
exception when others then
  get stacked diagnostics hint = pg_exception_hint;
  return jsonb_build_object('error', coalesce(nullif(hint, ''), sqlstate));
end; $$;
create function pa_test.u(n text) returns uuid language sql immutable as $$ select ('a5b00000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function pa_test.k(n integer) returns uuid language sql immutable as $$ select ('a5b30000-0000-4000-8000-'||lpad(n::text, 12, '0'))::uuid; $$;
create function pa_test.h(n integer) returns text language sql immutable as $$ select md5('admin-test-'||n)||md5('admin-test-code-'||n); $$;
create function pa_test.body(email text, venue_name text, lat double precision, lng double precision) returns jsonb language sql immutable as $$
  select jsonb_build_object('owner_name', 'Ana Cruz', 'email', email, 'phone', '+639171234567', 'role', 'owner',
    'venue', jsonb_build_object('name', venue_name, 'address_line', '8 Rizal Ave', 'city', 'Admintown',
      'province', 'Cebu', 'latitude', lat, 'longitude', lng, 'court_count', 3),
    'courts', jsonb_build_object('indoor', true, 'covered', true, 'surface', 'hard'),
    'note', 'Call after 5 pm.', 'consent', true); $$;
create function pa_test.read(actor uuid, status text default null, email text default null, after_at timestamptz default null, after_id uuid default null)
  returns jsonb language sql as $$
  select pa_test.call(format('select public.prelaunch_admin_read(%L, %L, %L, %L, %L)', actor, status, email, after_at, after_id)); $$;
create function pa_test.rotate(actor uuid, registration uuid, version integer, code integer) returns jsonb language sql as $$
  select pa_test.call(format('select public.prelaunch_admin_rotate(%L, %L, %L, %L)', actor, registration, version, pa_test.h(code))); $$;
create function pa_test.erase(actor uuid, registration uuid) returns jsonb language sql as $$
  select pa_test.call(format('select public.prelaunch_admin_erase(%L, %L)', actor, registration)); $$;
create function pa_test.check(actor uuid, code integer) returns jsonb language sql as $$
  select pa_test.call(format('select public.owner_registration_check(%L, %L)', actor, pa_test.h(code))); $$;
-- Fixture readers run as the test owner, so assertions may use them under any role.
create function pa_test.reg(key integer) returns private.venue_registrations language sql security definer as $$
  select r.* from private.venue_registrations r where r.request_key = pa_test.k(key); $$;
create function pa_test.listing(key integer) returns text language sql security definer as $$
  select v.publication_status || ':' || v.claim_status from public.venues v where v.id = (pa_test.reg(key)).venue_id; $$;
create function pa_test.audits(action text, actor uuid) returns integer language sql security definer as $$
  select count(*)::integer from private.directory_audit_events e where e.action = audits.action and e.actor_user_id = audits.actor; $$;
grant usage on schema pa_test to anon, authenticated, service_role;
grant execute on all functions in schema pa_test to anon, authenticated, service_role;

-- Only the console server (service_role) runs the three commands.
select pa_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname = 'public' and p.proname in ('prelaunch_admin_read', 'prelaunch_admin_rotate', 'prelaunch_admin_erase', 'prelaunch_email_sent')
    and has_function_privilege(r.name, p.oid, 'execute')), 'no client role runs registration admin commands');
select pa_test.assert_that(has_function_privilege('service_role', 'public.prelaunch_admin_read(uuid,text,text,timestamptz,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.prelaunch_admin_rotate(uuid,uuid,integer,text)', 'execute')
  and has_function_privilege('service_role', 'public.prelaunch_admin_erase(uuid,uuid)', 'execute')
  and has_function_privilege('service_role', 'public.prelaunch_email_sent(uuid,integer)', 'execute'), 'service role grants');

-- The list and the sweep count every registration: start from none (rolled back with everything else).
delete from private.venue_registrations;
-- Accounts: admin (1), moderator (2), claimant (3), a plain account for code checks (4).
insert into auth.users(id, email) values (pa_test.u('1'), 'admin@example.ph'), (pa_test.u('2'), 'mod@example.ph'),
  (pa_test.u('3'), 'claimer@example.ph'), (pa_test.u('4'), 'checker@example.ph');
insert into private.account_roles(user_id, role) values (pa_test.u('1'), 'admin'), (pa_test.u('2'), 'moderator');
insert into storage.objects(bucket_id, name) values ('owner-evidence', pa_test.u('3')::text || '/a5b40000-0000-4000-8000-000000000001.jpg');

-- Registrations (T53 command): 1 open, 2 claimed by account 3, 3 suspended listing, 4 published and verified listing,
-- 5 erased by the sweep, 6 open with no delivered email, 7 open from another address.
set local role service_role;
select pa_test.assert_that(bool_and(public.prelaunch_register(pa_test.k(n), pa_test.body(e, nm, lat, lng), pa_test.h(n), true)->>'outcome' = 'created'),
  'registrations created') from (values (1, 'ana@example.ph', 'Open Courts', 10.31, 123.89), (2, 'ana@example.ph', 'Claimed Courts', 10.50, 124.00),
  (3, 'ana@example.ph', 'Suspended Courts', 7.07, 125.61), (4, 'ana@example.ph', 'Verified Courts', 9.30, 123.30),
  (5, 'ana@example.ph', 'Erased Courts', 16.41, 120.59), (6, 'ana@example.ph', 'Unsent Courts', 13.62, 123.18),
  (7, 'other@example.ph', 'Other Courts', 15.00, 120.60)) r(n, e, nm, lat, lng);
select pa_test.assert_that(bool_and(public.prelaunch_email_sent((pa_test.reg(n)).id, 1)), 'emails delivered') from generate_series(1, 7) n where n <> 6;
reset role;
select pa_test.assert_that(bool_and((pa_test.reg(n)).email_sent_version is not distinct from case when n = 6 then null else 1 end), 'delivered version recorded')
  from generate_series(1, 7) n;
update public.venues set publication_status = 'suspended' where id = (pa_test.reg(3)).venue_id;
update public.venues set publication_status = 'approved', claim_status = 'verified' where id = (pa_test.reg(4)).venue_id;
update private.venue_registrations set email_sent_at = clock_timestamp() - interval '181 days' where request_key = pa_test.k(5);
select pa_test.assert_that((select r->>'prelaunch_registrations' = '1' from private.privacy_retention_sweep(500) r), 'registration 5 erased by the sweep');
set local role service_role;
select pa_test.assert_that(public.owner_redeem_registration(pa_test.u('3'), pa_test.k(90), pa_test.h(2),
  pa_test.u('3')::text || '/a5b40000-0000-4000-8000-000000000001.jpg', null)->>'outcome' = 'created', 'registration 2 claimed');
reset role;
select pa_test.assert_that((pa_test.reg(2)).status = 'claimed' and (pa_test.reg(5)).status = 'erased', 'statuses ready');

-- Reading: admins only.
set local role service_role;
select pa_test.assert_that(pa_test.read(pa_test.u('2'))->>'error' = '42501', 'moderators cannot list registrations');
select pa_test.assert_that(pa_test.read(pa_test.u('3'))->>'error' = '42501', 'players cannot list registrations');
select pa_test.assert_that(pa_test.read('a5b00000-0000-4000-8000-000000000099')->>'error' = '42501', 'unknown accounts cannot list registrations');
select pa_test.assert_that(pa_test.read(pa_test.u('1'), 'pending')->>'error' = 'invalid_input', 'unknown status filter');
select pa_test.assert_that(pa_test.read(pa_test.u('1'), null, null, clock_timestamp(), null)->>'error' = 'invalid_input', 'half a cursor');
select pa_test.assert_that(pa_test.read(pa_test.u('1'), null, repeat('a', 250) || '@x.ph')->>'error' = 'invalid_input', 'overlong email filter');
create temporary table everything on commit drop as select pa_test.read(pa_test.u('1')) r;
reset role;
select pa_test.assert_that((select jsonb_array_length(r->'items') = 7 and r->'next_cursor' = 'null'::jsonb
  and r->'counts' = '{"open": 5, "claimed": 1, "erased": 1}'::jsonb from everything), 'all registrations and counts');
with items as (select (e->>'registered_at')::timestamptz as at, (e->>'id')::uuid as id, n
  from everything, jsonb_array_elements(r->'items') with ordinality x(e, n))
select pa_test.assert_that(bool_and((a.at, a.id) > (b.at, b.id)), 'newest first') from items a join items b on b.n = a.n + 1;
select pa_test.assert_that((select e->'contact' = '{"owner_name": "Ana Cruz", "email": "ana@example.ph", "phone": "+639171234567", "note": "Call after 5 pm."}'::jsonb
  and e->>'status' = 'open' and e->>'role' = 'owner' and e->>'code_version' = '1' and e->>'email_sent_version' = '1' and e->'email_sent_at' <> 'null'::jsonb
  and e->'venue' = jsonb_build_object('id', (pa_test.reg(1)).venue_id, 'name', 'Open Courts', 'city', 'Admintown', 'province', 'Cebu',
    'publication_status', 'draft', 'claim_status', 'unclaimed', 'court_count', 3)
  and e->'claimed_at' = 'null'::jsonb and e->'submission_id' = 'null'::jsonb and e->'erased_at' = 'null'::jsonb
  from everything, jsonb_array_elements(r->'items') e where e->>'id' = (pa_test.reg(1)).id::text), 'open row with contacts and listing');
select pa_test.assert_that((select e->'contact' = 'null'::jsonb and e->'erased_at' <> 'null'::jsonb
  from everything, jsonb_array_elements(r->'items') e where e->>'id' = (pa_test.reg(5)).id::text), 'erased rows carry no contacts');
select pa_test.assert_that((select e->>'status' = 'claimed' and e->>'submission_id' = (pa_test.reg(2)).submission_id::text and e->'claimed_at' <> 'null'::jsonb
  and e->'contact'->>'email' = 'ana@example.ph' and e->'venue'->>'claim_status' = 'pending'
  from everything, jsonb_array_elements(r->'items') e where e->>'id' = (pa_test.reg(2)).id::text), 'claimed row links its submission');
select pa_test.assert_that((select e->'email_sent_at' = 'null'::jsonb and e->'email_sent_version' = 'null'::jsonb
  from everything, jsonb_array_elements(r->'items') e where e->>'id' = (pa_test.reg(6)).id::text), 'undelivered row');
set local role service_role;
select pa_test.assert_that((select jsonb_array_length(r->'items') = 1 and r->'items'->0->>'id' = (pa_test.reg(2)).id::text
  and r->'counts' = '{"open": 5, "claimed": 1, "erased": 1}'::jsonb from pa_test.read(pa_test.u('1'), 'claimed') r), 'status filter');
select pa_test.assert_that((select jsonb_array_length(r->'items') = 1 and r->'items'->0->>'id' = (pa_test.reg(7)).id::text
  and r->'counts' = '{"open": 1, "claimed": 0, "erased": 0}'::jsonb from pa_test.read(pa_test.u('1'), null, '  Other@Example.PH ') r), 'email filter, any case');
select pa_test.assert_that((select jsonb_array_length(r->'items') = 4 from pa_test.read(pa_test.u('1'), 'open', 'ana@example.ph') r), 'both filters');
select pa_test.assert_that((select jsonb_array_length(r->'items') = 7 from pa_test.read(pa_test.u('1'), null, '  ') r), 'a blank email filter is no filter');
reset role;

-- Paging: 52 more rows (trusted SQL) under one address, newest first, 50 a page.
insert into private.venue_registrations (id, request_key, venue_id, owner_name, email, role, consent_at, duplicates_acknowledged, code_hash, created_at)
  select gen_random_uuid(), pa_test.k(200 + n), (pa_test.reg(1)).venue_id, 'Page ' || n, 'page@example.ph', 'staff', clock_timestamp(), false,
    pa_test.h(200 + n), clock_timestamp() - make_interval(mins => n) from generate_series(1, 52) n;
set local role service_role;
create temporary table first_page on commit drop as select pa_test.read(pa_test.u('1'), null, 'page@example.ph') r;
select pa_test.assert_that((select jsonb_array_length(r->'items') = 50 and r->'items'->0->'contact'->>'owner_name' = 'Page 1'
  and r->'items'->49->'contact'->>'owner_name' = 'Page 50' and r->'next_cursor'->>'id' = r->'items'->49->>'id'
  and r->'counts'->>'open' = '52' from first_page), 'first page');
select pa_test.assert_that((select jsonb_array_length(p->'items') = 2 and p->'items'->0->'contact'->>'owner_name' = 'Page 51'
  and p->'items'->1->'contact'->>'owner_name' = 'Page 52' and p->'next_cursor' = 'null'::jsonb
  from first_page f, pa_test.read(pa_test.u('1'), null, 'page@example.ph', (f.r->'next_cursor'->>'created_at')::timestamptz,
    (f.r->'next_cursor'->>'id')::uuid) p), 'second page');
reset role;
delete from private.venue_registrations where email = 'page@example.ph';

-- Rotation: admins only, open registrations whose listing can still be claimed, at the version the admin saw.
set local role service_role;
select pa_test.assert_that(pa_test.rotate(pa_test.u('2'), (pa_test.reg(1)).id, 1, 101)->>'error' = '42501', 'moderators cannot send codes');
select pa_test.assert_that(pa_test.call(format('select public.prelaunch_admin_rotate(%L, %L, 1, %L)', pa_test.u('1'), (pa_test.reg(1)).id, 'not-a-hash'))->>'error' = 'invalid_input', 'bad hash');
select pa_test.assert_that(pa_test.call(format('select public.prelaunch_admin_rotate(%L, %L, null, %L)', pa_test.u('1'), (pa_test.reg(1)).id, pa_test.h(101)))->>'error' = 'invalid_input', 'no version');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), 'a5b00000-0000-4000-8000-000000000099', 1, 101)->>'error' = 'not_found', 'unknown registration');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(1)).id, 2, 101)->>'error' = 'changed', 'stale version');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(2)).id, 1, 101)->>'error' = 'not_open', 'claimed registrations keep their state');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(5)).id, 1, 101)->>'error' = 'not_open', 'erased registrations get no code');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(3)).id, 1, 101)->>'error' = 'listing_unavailable', 'suspended listing');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(4)).id, 1, 101)->>'error' = 'already_verified', 'verified listing');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(1)).id, 1, 7)->>'error' = 'code_collision', 'another registration''s code');
reset role;
select pa_test.assert_that((select code_hash = pa_test.h(1) and code_version = 1 from pa_test.reg(1))
  and (select code_hash is null and status = 'claimed' from pa_test.reg(2)) and pa_test.audits('prelaunch.code_send', pa_test.u('1')) = 0,
  'refusals change nothing');
set local role service_role;
create temporary table rotated on commit drop as select pa_test.rotate(pa_test.u('1'), (pa_test.reg(1)).id, 1, 101) r;
reset role;
select pa_test.assert_that((select r = jsonb_build_object('outcome', 'rotated', 'registration_id', (pa_test.reg(1)).id, 'code_version', 2,
  'owner_name', 'Ana Cruz', 'email', 'ana@example.ph', 'venue_name', 'Open Courts') from rotated), 'rotation result');
select pa_test.assert_that((select code_hash = pa_test.h(101) and code_version = 2 and email_sent_version = 1 and status = 'open' from pa_test.reg(1)),
  'new hash, new version, old delivery');
select pa_test.assert_that(pa_test.audits('prelaunch.code_send', pa_test.u('1')) = 1
  and exists (select 1 from private.directory_audit_events e where e.action = 'prelaunch.code_send' and e.target_venue_id = (pa_test.reg(1)).venue_id),
  'audited with the admin as actor');
set local role service_role;
select pa_test.assert_that(pa_test.check(pa_test.u('4'), 1)->>'outcome' = 'invalid', 'the old code stops working');
select pa_test.assert_that(pa_test.check(pa_test.u('4'), 101)->>'outcome' = 'valid', 'the new code works');
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(1)).id, 1, 102)->>'error' = 'changed', 'a double send is refused');
select pa_test.assert_that(not public.prelaunch_email_sent((pa_test.reg(1)).id, 1), 'a late delivery of the old code is ignored');
reset role;
update private.venue_registrations set email_sent_at = clock_timestamp() - interval '200 days', created_at = clock_timestamp() - interval '200 days'
  where request_key = pa_test.k(1);
set local role service_role;
select pa_test.assert_that(public.prelaunch_email_sent((pa_test.reg(1)).id, 2), 'the new code delivered');
reset role;
select pa_test.assert_that((select email_sent_version = 2 and email_sent_at > clock_timestamp() - interval '1 minute' from pa_test.reg(1)), 'delivered version 2');
select pa_test.assert_that((select r->>'prelaunch_registrations' = '0' from private.privacy_retention_sweep(500) r) and (pa_test.reg(1)).status = 'open',
  'the sweep counts from the new email');
-- A registration whose first email never went out can get a code from the console too.
set local role service_role;
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(6)).id, 1, 106)->>'code_version' = '2', 'undelivered registration rotated');
reset role;
select pa_test.assert_that((select email_sent_at is null and email_sent_version is null and code_hash = pa_test.h(106) from pa_test.reg(6)), 'still undelivered');
-- A revoked admin is refused at once.
delete from private.account_roles where user_id = pa_test.u('1');
set local role service_role;
select pa_test.assert_that(pa_test.rotate(pa_test.u('1'), (pa_test.reg(7)).id, 1, 107)->>'error' = '42501', 'revoked admin');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), (pa_test.reg(7)).id)->>'error' = '42501', 'revoked admin cannot erase');
reset role;
insert into private.account_roles(user_id, role) values (pa_test.u('1'), 'admin');

-- Erasure: open (draft suspended), published (listing stays), claimed (draft stays the claimant's) and erased (existing).
set local role service_role;
select pa_test.assert_that(pa_test.erase(pa_test.u('2'), (pa_test.reg(7)).id)->>'error' = '42501', 'moderators cannot erase');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), 'a5b00000-0000-4000-8000-000000000099')->>'error' = 'not_found', 'unknown registration');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), (pa_test.reg(7)).id)
  = jsonb_build_object('outcome', 'erased', 'registration_id', (pa_test.reg(7)).id, 'listing_suspended', true), 'open registration erased');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), (pa_test.reg(4)).id)->>'listing_suspended' = 'false', 'published listing erased');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), (pa_test.reg(2)).id)
  = jsonb_build_object('outcome', 'erased', 'registration_id', (pa_test.reg(2)).id, 'listing_suspended', false), 'claimed registration erased');
select pa_test.assert_that(pa_test.erase(pa_test.u('1'), (pa_test.reg(5)).id)
  = jsonb_build_object('outcome', 'existing', 'registration_id', (pa_test.reg(5)).id, 'listing_suspended', false), 'erased registration unchanged');
select pa_test.assert_that(pa_test.check(pa_test.u('4'), 7)->>'outcome' = 'invalid', 'an erased code stops working');
reset role;
select pa_test.assert_that((select status = 'erased' and owner_name is null and email is null and phone is null and note is null and code_hash is null
  and erased_at is not null from pa_test.reg(7)) and pa_test.listing(7) = 'suspended:unclaimed', 'open: contacts and code gone, draft suspended');
select pa_test.assert_that((select status = 'erased' and email is null from pa_test.reg(4)) and pa_test.listing(4) = 'approved:verified', 'published listing untouched');
select pa_test.assert_that((select status = 'erased' and owner_name is null and email is null and claimed_by = pa_test.u('3') and submission_id is not null from pa_test.reg(2))
  and pa_test.listing(2) = 'draft:pending'
  and exists (select 1 from private.venue_submissions s where s.id = (pa_test.reg(2)).submission_id and s.status = 'pending'),
  'claimed: contacts gone, the pending submission and its draft stay');
select pa_test.assert_that(pa_test.audits('prelaunch.erase', pa_test.u('1')) = 3, 'three erasures audited, none for the existing one');
select pa_test.assert_that(not exists (select 1 from private.directory_audit_events e where e.action = 'prelaunch.retire' and e.actor_user_id = pa_test.u('1')),
  'admin erasure is not the sweep''s retirement');

drop schema pa_test cascade;
rollback;
