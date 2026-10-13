-- Rollback-only fixtures for T53 pre-launch registrations: grants, validation, the private draft plus registration
-- plus audit row in one command, duplicates, retries and code rotation, delivery records, the per-address cap,
-- draft invisibility, the delete blocker and the 180-day privacy sweep. Runs on PGlite and Docker.
begin;
create schema pre_test;
create function pre_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Prelaunch assertion failed: %', message; end if; end; $$;
create function pre_test.expect_error(statement text, code text, hint text default null, detail text default null) returns void language plpgsql as $$
declare actual_hint text; actual_detail text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint = pg_exception_hint, actual_detail = pg_exception_detail;
    if sqlstate = code and (hint is null or actual_hint = hint) and (detail is null or actual_detail = detail) then return; end if;
    raise exception 'Expected %/%/%, got %/%/%: %', code, hint, detail, sqlstate, actual_hint, actual_detail, sqlerrm;
  end;
  raise exception 'Expected failure: %', statement;
end; $$;
create function pre_test.u(n text) returns uuid language sql immutable as $$ select ('af100000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function pre_test.v(n text) returns uuid language sql immutable as $$ select ('af200000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function pre_test.k(n integer) returns uuid language sql immutable as $$ select ('af300000-0000-4000-8000-'||lpad(n::text, 12, '0'))::uuid; $$;
create function pre_test.h(n integer) returns text language sql immutable as $$ select md5('pre-test-'||n)||md5('pre-test-code-'||n); $$;
create function pre_test.body(email text default 'ana@example.ph', lat double precision default 14.5501,
  lng double precision default 121.0201, patch jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('owner_name', 'Ana Cruz', 'email', email, 'phone', '+639171234567', 'role', 'manager',
    'venue', jsonb_build_object('name', 'Prelaunch Fixture Courts', 'address_line', '12 Mabini St', 'city', 'Pretestville',
      'province', 'Metro Manila', 'latitude', lat, 'longitude', lng, 'court_count', 4),
    'courts', jsonb_build_object('indoor', true, 'covered', true, 'surface', 'synthetic'),
    'note', 'Gate on Mabini St.', 'consent', true) || patch; $$;
create function pre_test.reg(key integer, body jsonb, hash integer, ack boolean default false) returns jsonb language sql as $$
  select public.prelaunch_register(pre_test.k(key), body, pre_test.h(hash), ack); $$;
create function pre_test.bad(body jsonb, hash text default null, key uuid default null) returns void language sql as $$
  select pre_test.expect_error(format('select public.prelaunch_register(%L, %L, %L, true)',
    coalesce(key, pre_test.k(999)), body, coalesce(hash, pre_test.h(999))), '22023', 'invalid_input'); $$;
grant usage on schema pre_test to anon, authenticated, service_role;
grant execute on all functions in schema pre_test to anon, authenticated, service_role;

-- Only the registration server (service_role) runs the two commands; nobody reads or writes registrations directly.
select pre_test.assert_that(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  cross join (values ('anon'), ('authenticated')) r(name)
  where n.nspname in ('public','private') and p.proname in ('prelaunch_register','prelaunch_email_sent','validate_prelaunch_registration',
    'prelaunch_result','privacy_retention_sweep','directory_delete_blocker') and has_function_privilege(r.name, p.oid, 'execute')),
  'no client role runs prelaunch commands');
select pre_test.assert_that(has_function_privilege('service_role', 'public.prelaunch_register(uuid,jsonb,text,boolean)', 'execute')
  and has_function_privilege('service_role', 'public.prelaunch_email_sent(uuid,integer)', 'execute')
  and not has_function_privilege('service_role', 'private.validate_prelaunch_registration(jsonb)', 'execute')
  and not has_function_privilege('service_role', 'private.privacy_retention_sweep(integer)', 'execute'), 'service role grants');
select pre_test.assert_that(not exists(select 1 from (values ('anon'), ('authenticated'), ('service_role')) r(name)
  cross join (values ('select'), ('insert'), ('update'), ('delete')) p(privilege)
  where has_table_privilege(r.name, 'private.venue_registrations', p.privilege)), 'no role touches the registrations table directly');
select pre_test.assert_that((select relrowsecurity from pg_class where oid = 'private.venue_registrations'::regclass), 'RLS enabled');

-- Fixtures: an approved listing (1) and another draft (2) within 150 m of the pin; an admin (1) and a player (2).
insert into auth.users(id) values (pre_test.u('1')), (pre_test.u('2'));
insert into private.account_roles(user_id, role) values (pre_test.u('1'), 'admin');
insert into public.venues(id, name, address_line, city, province, latitude, longitude, publication_status) values
  (pre_test.v('1'), 'Approved Fixture Hall', '10 Mabini St', 'Pretestville', 'Metro Manila', 14.5500, 121.0200, 'approved'),
  (pre_test.v('2'), 'Hidden Draft Fixture', '11 Mabini St', 'Pretestville', 'Metro Manila', 14.5502, 121.0202, 'draft');
insert into public.courts(venue_id, name) values (pre_test.v('1'), 'Court 1'), (pre_test.v('2'), 'Court 1');

set local role service_role;
select pre_test.expect_error($$insert into private.venue_registrations(id, request_key, venue_id, role, consent_at, duplicates_acknowledged)
  values (gen_random_uuid(), gen_random_uuid(), 'af200000-0000-4000-8000-000000000001', 'owner', now(), false)$$, '42501');
-- Validation: everything the page sends is checked again here.
select pre_test.bad(pre_test.body(patch => '{"consent": false}'));
select pre_test.bad(pre_test.body() - 'consent');
select pre_test.bad(pre_test.body(patch => '{"extra": 1}'));
select pre_test.bad(pre_test.body('Ana@Example.ph'));
select pre_test.bad(pre_test.body('ana@example'));
select pre_test.bad(pre_test.body(patch => '{"phone": "09171234567"}'));
select pre_test.bad(pre_test.body(patch => '{"phone": 9171234567}'));
select pre_test.bad(pre_test.body(patch => '{"role": "admin"}'));
select pre_test.bad(pre_test.body(patch => '{"owner_name": " Ana"}'));
select pre_test.bad(pre_test.body(patch => jsonb_build_object('owner_name', 'Ana'||chr(7))));
select pre_test.bad(pre_test.body(patch => jsonb_build_object('owner_name', repeat('a', 121))));
select pre_test.bad(pre_test.body(patch => jsonb_build_object('note', repeat('a', 501))));
select pre_test.bad(pre_test.body(patch => '{"courts": {"indoor": true, "covered": true}}'));
select pre_test.bad(pre_test.body(patch => '{"courts": {"indoor": "yes", "covered": true, "surface": null}}'));
select pre_test.bad(pre_test.body(patch => '{"courts": {"indoor": true, "covered": true, "surface": "clay"}}'));
select pre_test.bad(pre_test.body(lat => 35.6));
select pre_test.bad(pre_test.body(patch => jsonb_build_object('venue', (pre_test.body()->'venue') || '{"court_count": 41}')));
select pre_test.bad(pre_test.body(patch => jsonb_build_object('venue', (pre_test.body()->'venue') || '{"court_count": 0}')));
select pre_test.bad(pre_test.body(), 'not-a-hash');
select pre_test.bad(pre_test.body(), upper(pre_test.h(999)));
select pre_test.expect_error(format('select public.prelaunch_register(null, %L, %L, true)', pre_test.body(), pre_test.h(1)), '22023', 'invalid_input');

-- An approved listing nearby must be acknowledged first; nothing is written and drafts are never revealed.
select pre_test.assert_that((select r->>'outcome' = 'duplicates' and r->>'registration_id' is null and not (r->>'send')::boolean
  and jsonb_array_length(r->'duplicates') = 1 and r->'duplicates'->0->>'id' = pre_test.v('1')::text
  and (r->'duplicates')::text not like '%Hidden Draft%' from pre_test.reg(1, pre_test.body(), 1) r), 'duplicates outcome, approved only');
reset role;
select pre_test.assert_that(not exists (select 1 from private.venue_registrations) and
  (select count(*) from public.venues where city = 'Pretestville') = 2, 'duplicates wrote nothing');

-- Acknowledged: one private unclaimed draft with Court 1..4, its registration and one audit row.
set local role service_role;
create temporary table first_result on commit drop as select pre_test.reg(1, pre_test.body(), 1, true) r;
reset role;
select pre_test.assert_that((select r->>'outcome' = 'created' and (r->>'send')::boolean and (r->>'code_version')::int = 1
  and r->>'venue_name' = 'Prelaunch Fixture Courts' from first_result), 'created result');
create temporary table first_row on commit drop as
  select g.* from private.venue_registrations g where g.id = (select (r->>'registration_id')::uuid from first_result);
select pre_test.assert_that((select count(*) = 1 from first_row), 'registration stored');
select pre_test.assert_that((select v.publication_status = 'draft' and v.claim_status = 'unclaimed' and v.name = 'Prelaunch Fixture Courts'
  and v.city = 'Pretestville' and v.latitude = 14.5501 from public.venues v join first_row g on g.venue_id = v.id), 'unclaimed private draft');
select pre_test.assert_that((select string_agg(c.name||':'||c.surface||':'||c.is_indoor||':'||c.is_covered||':'||c.status, ',' order by c.name)
  from public.courts c join first_row g on g.venue_id = c.venue_id)
  = 'Court 1:synthetic:true:true:active,Court 2:synthetic:true:true:active,Court 3:synthetic:true:true:active,Court 4:synthetic:true:true:active', 'courts 1..4');
select pre_test.assert_that((select g.request_key = pre_test.k(1) and g.status = 'open' and g.owner_name = 'Ana Cruz' and g.email = 'ana@example.ph'
  and g.phone = '+639171234567' and g.role = 'manager' and g.note = 'Gate on Mabini St.' and g.consent_at is not null
  and g.duplicates_acknowledged and g.code_hash = pre_test.h(1) and g.code_version = 1 and g.email_sent_at is null
  and g.nearby_venue_ids @> array[pre_test.v('1'), pre_test.v('2')] from first_row g), 'registration fields and reviewer snapshot');
select pre_test.assert_that((select count(*) = 1 and bool_and(e.action = 'prelaunch.register' and e.actor_user_id = g.id)
  from private.directory_audit_events e join first_row g on e.target_venue_id = g.venue_id), 'one audit row, actor is the registration');
select pre_test.assert_that(not exists (select 1 from private.venue_owners o join first_row g on g.venue_id = o.venue_id)
  and not exists (select 1 from private.venue_submissions s join first_row g on g.venue_id = s.venue_id), 'no owner link or submission');

-- Drafts never reach public reads, search or any account's owner access.
grant select on first_row to anon, service_role;
set local role anon;
select pre_test.assert_that(not exists (select 1 from public.venues where city = 'Pretestville' and publication_status <> 'approved')
  and (select count(*) from public.venues where city = 'Pretestville') = 1
  and (select count(*) from public.courts c where c.venue_id in (select g.venue_id from first_row g)) = 0, 'anon reads skip the draft');
select pre_test.assert_that((select count(*) from public.venues_in_bounds(14.54, 121.01, 14.56, 121.03)) = 1, 'bounds read skips the draft');
reset role;
set local role service_role;
select pre_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Pretestville"}')->'venues') = 1, 'search skips the draft');
select pre_test.assert_that(public.owner_venue_list(pre_test.u('2')) = '[]'::jsonb, 'no account manages the draft');
reset role;
select pre_test.assert_that(not private.is_venue_editor(pre_test.u('2'), (select venue_id from first_row))
  and not private.has_venue_relationship(pre_test.u('1'), (select venue_id from first_row)), 'no editor or relationship');

-- A retry before the email went out rotates the code (the old hash is gone); no second draft.
set local role service_role;
select pre_test.assert_that((select r->>'outcome' = 'existing' and (r->>'send')::boolean and (r->>'code_version')::int = 2
  and r->>'registration_id' = (select (fr.r->>'registration_id') from first_result fr) from pre_test.reg(1, pre_test.body(), 2, true) r), 'rotating retry');
reset role;
select pre_test.assert_that((select g.code_hash = pre_test.h(2) and g.code_version = 2 from private.venue_registrations g where g.id = (select id from first_row))
  and not exists (select 1 from private.venue_registrations where code_hash = pre_test.h(1))
  and (select count(*) from public.venues where city = 'Pretestville') = 3, 'code rotated, still one draft');
-- Delivery is recorded only for the version that was sent.
set local role service_role;
select pre_test.assert_that(not public.prelaunch_email_sent((select id from first_row), 1), 'stale version not recorded');
select pre_test.assert_that(public.prelaunch_email_sent((select id from first_row), 2), 'current version recorded');
select pre_test.assert_that(not public.prelaunch_email_sent(pre_test.k(77), 1), 'unknown registration');
select pre_test.expect_error('select public.prelaunch_email_sent(null, 1)', '22023', 'invalid_input');
-- After delivery a retry returns the original without rotating or sending.
select pre_test.assert_that((select r->>'outcome' = 'existing' and not (r->>'send')::boolean and (r->>'code_version')::int = 2
  from pre_test.reg(1, pre_test.body(), 3, true) r), 'retry after delivery');
-- The same request key with another address, or a code that already exists, is refused.
select pre_test.expect_error(format('select public.prelaunch_register(%L, %L, %L, true)', pre_test.k(1), pre_test.body('other@example.ph'), pre_test.h(4)), '23505', 'request_reused');
select pre_test.expect_error(format('select public.prelaunch_register(%L, %L, %L, true)', pre_test.k(5), pre_test.body('other@example.ph', 10.3, 123.9), pre_test.h(2)), '23505', 'code_collision');
reset role;
select pre_test.assert_that((select g.code_hash = pre_test.h(2) and g.email_sent_at is not null from private.venue_registrations g where g.id = (select id from first_row)), 'unchanged after refusals');

-- At most 10 open registrations per address: the 11th writes nothing and says "limit".
set local role service_role;
select pre_test.assert_that(bool_and(pre_test.reg(100 + n, pre_test.body(lat => 10.3, lng => 123.9), 100 + n)->>'outcome' = 'created'), 'nine more created')
  from generate_series(1, 9) n;
select pre_test.assert_that((select r->>'outcome' = 'limit' and not (r->>'send')::boolean and r->>'registration_id' is null
  from pre_test.reg(200, pre_test.body(lat => 10.3, lng => 123.9), 200) r), 'limit outcome');
select pre_test.assert_that((select r->>'outcome' = 'created' from pre_test.reg(201, pre_test.body('other@example.ph', 10.3, 123.9), 201) r), 'other address unaffected');
reset role;
select pre_test.assert_that((select count(*) from private.venue_registrations where email = 'ana@example.ph') = 10
  and not exists (select 1 from private.venue_registrations where request_key = pre_test.k(200)), 'cap held');

-- A registration's listing can't be deleted; suspend it instead.
set local role service_role;
select pre_test.expect_error(format('select public.directory_admin_delete(%L, %L, %L)', pre_test.u('1'), (select venue_id from first_row),
  (select updated_at from public.venues where id = (select venue_id from first_row))), '55006', 'listing_in_use', 'registration');
reset role;

-- Privacy sweep: open registrations 180 days after their last code email (or creation, if never sent) are erased
-- and their still-draft listing retired; a listing an admin already published stays published.
update private.venue_registrations set email_sent_at = clock_timestamp() - interval '181 days' where id = (select id from first_row);
update private.venue_registrations set created_at = clock_timestamp() - interval '181 days' where request_key = pre_test.k(101);
update private.venue_registrations set email_sent_at = clock_timestamp() - interval '179 days' where request_key = pre_test.k(102);
update private.venue_registrations set created_at = clock_timestamp() - interval '200 days', email_sent_at = clock_timestamp() - interval '10 days'
  where request_key = pre_test.k(103);
update private.venue_registrations set created_at = clock_timestamp() - interval '181 days' where request_key = pre_test.k(104);
update public.venues set publication_status = 'approved' where id = (select venue_id from private.venue_registrations where request_key = pre_test.k(104));
select pre_test.assert_that((select r->>'prelaunch_registrations' = '3' and r->>'more' = 'false' from private.privacy_retention_sweep(500) r), 'three erased');
select pre_test.assert_that((select count(*) = 3 and bool_and(g.status = 'erased' and g.owner_name is null and g.email is null and g.phone is null
  and g.note is null and g.code_hash is null and g.erased_at is not null and g.role = 'manager')
  from private.venue_registrations g where g.request_key in (pre_test.k(1), pre_test.k(101), pre_test.k(104))), 'contact details and code erased');
select pre_test.assert_that((select count(*) = 0 from private.venue_registrations g
  where g.request_key in (pre_test.k(102), pre_test.k(103)) and g.status <> 'open'), 'recent deliveries kept');
select pre_test.assert_that((select string_agg(g.request_key::text||':'||v.publication_status, ',' order by g.request_key)
  from private.venue_registrations g join public.venues v on v.id = g.venue_id where g.request_key in (pre_test.k(1), pre_test.k(101), pre_test.k(104)))
  = format('%s:suspended,%s:suspended,%s:approved', pre_test.k(1), pre_test.k(101), pre_test.k(104)), 'drafts retired, published listing kept');
select pre_test.assert_that((select count(*) = 2 and bool_and(e.actor_user_id = g.id) from private.directory_audit_events e
  join private.venue_registrations g on g.venue_id = e.target_venue_id where e.action = 'prelaunch.retire'), 'retirements audited');
select pre_test.assert_that((select r->>'prelaunch_registrations' = '0' from private.privacy_retention_sweep(500) r), 'second sweep idempotent');
select pre_test.assert_that((select r->>'prelaunch_registrations' = '0' and r->>'more' = 'false' from private.privacy_retention_sweep(1) r), 'nothing left due');
-- Erased rows free the cap and their request keys can't be reused for another address.
set local role service_role;
select pre_test.assert_that((select r->>'outcome' = 'duplicates' from pre_test.reg(202, pre_test.body(lat => 10.3, lng => 123.9), 202) r), 'the published listing now warns');
select pre_test.assert_that((select r->>'outcome' = 'created' from pre_test.reg(202, pre_test.body(lat => 10.3, lng => 123.9), 202, true) r), 'cap freed by erasure');
select pre_test.expect_error(format('select public.prelaunch_register(%L, %L, %L, true)', pre_test.k(1), pre_test.body(), pre_test.h(5)), '23505', 'request_reused');
reset role;
select pre_test.expect_error($$update private.venue_registrations set email = 'x@example.ph' where request_key = 'af300000-0000-4000-8000-000000000001'$$, '23514');
select pre_test.expect_error($$update private.venue_registrations set code_hash = null where request_key = 'af300000-0000-4000-8000-000000000102'$$, '23514');
rollback;
