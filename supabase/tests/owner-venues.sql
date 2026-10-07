-- Synthetic, rollback-only owner venue editing acceptance. Never run on hosted data.
begin;
create schema venues_test;
create function venues_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Owner venue assertion failed: %', message; end if; end;
$$;
-- Checks SQLSTATE and, when given, the machine-readable hint the server maps.
create function venues_test.expect_error(statement text, expected_code text, expected_hint text default null) returns void
language plpgsql as $$
declare actual_hint text;
begin
  begin
    execute statement;
  exception when others then
    get stacked diagnostics actual_hint = pg_exception_hint;
    if sqlstate = expected_code and (expected_hint is null or actual_hint = expected_hint) then return; end if;
    raise exception 'Expected %/%, got %/% (%): %', expected_code, expected_hint, sqlstate, actual_hint, sqlerrm, statement;
  end;
  raise exception 'Expected % but statement succeeded: %', expected_code, statement;
end;
$$;
-- Builds a save call for the owner/venue with the listing's current version unless one is given.
create function venues_test.save(actor uuid, venue uuid, venue_input jsonb, courts jsonb, version timestamptz default null) returns jsonb
language sql as $$
  select public.owner_venue_save(actor, venue, coalesce(version, (select updated_at from public.venues where id = venue)), venue_input, courts);
$$;
grant usage on schema venues_test to anon, authenticated, service_role;
grant execute on all functions in schema venues_test to anon, authenticated, service_role;

-- 01 owner A, 02 player, 03 owner B, 04 revoked owner, 09 admin.
insert into auth.users(id) values
  ('51000000-0000-4000-8000-000000000001'), ('51000000-0000-4000-8000-000000000002'),
  ('51000000-0000-4000-8000-000000000003'), ('51000000-0000-4000-8000-000000000004'),
  ('51000000-0000-4000-8000-000000000009');
insert into private.account_roles(user_id, role) values ('51000000-0000-4000-8000-000000000009', 'admin');
-- An old explicit version, so a save inside this one transaction visibly changes it.
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status,updated_at) values
  ('52000000-0000-4000-8000-000000000001','Owner Edit Alpha','1 Fixture St','Manila','Metro Manila',14.6,121,'approved','verified','2026-01-01T00:00:00Z'),
  ('52000000-0000-4000-8000-000000000002','Owner Edit Beta','2 Fixture St','Manila','Metro Manila',14.61,121.01,'approved','verified','2026-01-01T00:00:00Z'),
  ('52000000-0000-4000-8000-000000000003','Owner Edit Draft','3 Fixture St','Manila','Metro Manila',14.62,121.02,'draft','verified','2026-01-01T00:00:00Z'),
  ('52000000-0000-4000-8000-000000000004','Owner Edit Suspended','4 Fixture St','Manila','Metro Manila',14.63,121.03,'suspended','verified','2026-01-01T00:00:00Z'),
  ('52000000-0000-4000-8000-000000000005','Owner Edit Gamma','5 Fixture St','Cebu City','Cebu',10.3,123.9,'approved','verified','2026-01-01T00:00:00Z'),
  ('52000000-0000-4000-8000-000000000006','Owner Edit Unclaimed','6 Fixture St','Cebu City','Cebu',10.31,123.91,'approved','unclaimed','2026-01-01T00:00:00Z');
insert into public.courts(id,venue_id,name,surface) values
  ('53000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','Court 1','hard'),
  ('53000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001','Court 2','hard'),
  ('53000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000002','Court 1',null),
  ('53000000-0000-4000-8000-000000000004','52000000-0000-4000-8000-000000000003','Court 1',null),
  ('53000000-0000-4000-8000-000000000005','52000000-0000-4000-8000-000000000004','Court 1',null),
  ('53000000-0000-4000-8000-000000000006','52000000-0000-4000-8000-000000000005','Court 1',null),
  ('53000000-0000-4000-8000-000000000007','52000000-0000-4000-8000-000000000006','Court 1',null);
insert into private.venue_owners(venue_id,user_id) values
  ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000003','51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000004','51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000005','51000000-0000-4000-8000-000000000003'),
  ('52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000004');
-- Server-uploaded photo objects (server-chosen <venue>/<uuid>.<ext>).
insert into storage.objects(bucket_id, name) select 'venue-photos', p from unnest(array[
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000002.png',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000003.jpg',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000004.jpg',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000005.jpg',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000006.jpg',
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000007.jpg',
  '52000000-0000-4000-8000-000000000002/54000000-0000-4000-8000-000000000011.jpg',
  '52000000-0000-4000-8000-000000000005/54000000-0000-4000-8000-000000000021.jpg']) p;
insert into storage.objects(bucket_id, name) values
  ('owner-evidence', '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000031.jpg');

select venues_test.assert_that((select public and file_size_limit = 5242880 and allowed_mime_types = array['image/jpeg','image/png']
  from storage.buckets where id = 'venue-photos'), 'public, bounded photo bucket');
select venues_test.assert_that(not exists(select 1 from pg_policies where schemaname = 'storage' and
  (qual ilike '%venue-photos%' or with_check ilike '%venue-photos%')), 'no client storage policy for venue photos');

-- Client roles: no commands, no private tables, no direct photo or storage writes.
set local role anon;
select venues_test.expect_error($q$select public.owner_venue_list('51000000-0000-4000-8000-000000000001')$q$, '42501');
select venues_test.expect_error($q$select public.owner_venue_save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',now(),'{}','[]')$q$, '42501');
select venues_test.expect_error($q$insert into public.venue_photos(venue_id,storage_path,width,height) values ('52000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',800,600)$q$, '42501');
select venues_test.expect_error($q$insert into storage.objects(bucket_id,name) values ('venue-photos','52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000099.jpg')$q$, '42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001')$q$, '42501');
select venues_test.expect_error($q$select public.owner_venue_save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',now(),'{}','[]')$q$, '42501');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid(),'x',800,600)$q$, '42501');
select venues_test.expect_error($q$select public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid())$q$, '42501');
select venues_test.expect_error($q$select * from private.venue_photo_requests$q$, '42501');
select venues_test.expect_error($q$update public.venues set name = 'Direct' where id = '52000000-0000-4000-8000-000000000001'$q$, '42501');
select venues_test.expect_error($q$insert into storage.objects(bucket_id,name) values ('venue-photos','52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000098.jpg')$q$, '42501');
select venues_test.assert_that((select count(*) = 0 from storage.objects where bucket_id = 'venue-photos'), 'clients cannot list photo objects');
reset role;

set local role service_role;
-- Linked venues, with editability explained.
select venues_test.expect_error($q$select public.owner_venue_list(null)$q$, '42501', 'actor_required');
select venues_test.assert_that((select jsonb_agg(jsonb_build_array(v->>'name', v->'editable', v->'active_court_count') order by v->>'name')
  = '[["Owner Edit Alpha",true,2],["Owner Edit Beta",true,1],["Owner Edit Draft",false,1],["Owner Edit Suspended",false,1]]'::jsonb
  from jsonb_array_elements(public.owner_venue_list('51000000-0000-4000-8000-000000000001')) v), 'owner sees their linked venues only');
select venues_test.assert_that(public.owner_venue_list('51000000-0000-4000-8000-000000000002') = '[]'::jsonb, 'players own nothing');
-- Reads: owners of approved, verified venues only.
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000001')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000003')$q$, 'P0002', 'venue_unavailable');
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000004')$q$, 'P0002', 'venue_unavailable');
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000001',gen_random_uuid())$q$, '42501', 'not_owner');
select venues_test.assert_that((select jsonb_array_length(r->'courts') = 2 and r->'photos' = '[]'::jsonb
  and (r->>'updated_at')::timestamptz = '2026-01-01T00:00:00Z' and not (r ?| array['location','owners','claimant_user_id'])
  from public.owner_venue_read('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001') r), 'owner reads the editable listing');

-- Saves: authorization before anything else.
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select venues_test.save(null,'52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000003','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, 'P0002', 'venue_unavailable');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000004','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, 'P0002', 'venue_unavailable');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000006','{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, '42501', 'not_owner');
-- Input bounds. Pins, publication and claim status are not owner fields.
select venues_test.expect_error(format($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',%L,'[]')$q$, input), '22023', 'invalid_input')
from unnest(array[
  '{}', '[]', '{"name":"X","address_line":"A","city":"C"}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.7,"longitude":121}',
  '{"name":"X","address_line":"A","city":"C","province":"P","publication_status":"approved"}',
  '{"name":"X","address_line":"A","city":"C","province":"P","claim_status":"unclaimed"}',
  '{"name":" X","address_line":"A","city":"C","province":"P"}',
  '{"name":"","address_line":"A","city":"C","province":"P"}',
  '{"name":"X\u0007","address_line":"A","city":"C","province":"P"}',
  '{"name":1,"address_line":"A","city":"C","province":"P"}'
]::jsonb[]) input;
select venues_test.expect_error(format($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}',%L)$q$, courts), '22023', 'invalid_input')
from unnest(array[
  '{}', '[1]', '[{"id":null,"name":"Court 9"}]',
  '[{"id":null,"name":" Court 9","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]',
  '[{"id":null,"name":"Court\u0001","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]',
  '[{"id":null,"name":"Court 9","surface":"clay","is_indoor":false,"is_covered":false,"status":"active"}]',
  '[{"id":null,"name":"Court 9","surface":null,"is_indoor":"no","is_covered":false,"status":"active"}]',
  '[{"id":null,"name":"Court 9","surface":null,"is_indoor":false,"is_covered":false,"status":"active","venue_id":"52000000-0000-4000-8000-000000000002"}]',
  '[{"id":null,"name":"Court 9","surface":null,"is_indoor":false,"is_covered":false,"status":"active"},{"id":null,"name":"Court 9","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]',
  -- Another venue's court, and a court ID that doesn't exist.
  '[{"id":"53000000-0000-4000-8000-000000000006","name":"Stolen","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]',
  '[{"id":"53000000-0000-4000-8000-000000000099","name":"Ghost","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]'
]::jsonb[]) courts;
select venues_test.expect_error(format($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}',%L)$q$,
  (select jsonb_agg(jsonb_build_object('id',null,'name','Extra '||n,'surface',null,'is_indoor',false,'is_covered',false,'status','active')) from generate_series(1,39) n)), '22023', 'too_many_courts');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[{"id":"53000000-0000-4000-8000-000000000001","name":"Court 1","surface":"hard","is_indoor":false,"is_covered":false,"status":"inactive"},{"id":"53000000-0000-4000-8000-000000000002","name":"Court 2","surface":"hard","is_indoor":false,"is_covered":false,"status":"inactive"}]')$q$, '22023', 'active_court_required');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[{"id":null,"name":"Court 2","surface":null,"is_indoor":false,"is_covered":false,"status":"active"}]')$q$, '23505', 'duplicate_court');
select venues_test.expect_error($q$select public.owner_venue_save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',null,'{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, '22023', 'invalid_input');
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"X","address_line":"A","city":"C","province":"P"}','[]','2025-12-31T23:59:59Z')$q$, '40001', 'version_conflict');

-- A successful save: details, an in-place rename, a deactivation and a new court.
create temp table venues_result(label text primary key, data jsonb);
grant select, insert on venues_result to service_role;
insert into venues_result select 'saved', venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
  '{"name":"Alpha Pickleball Club","address_line":"1 Rizal Ave","city":"Manila","province":"Metro Manila"}',
  '[{"id":"53000000-0000-4000-8000-000000000001","name":"Center Court","surface":"synthetic","is_indoor":true,"is_covered":true,"status":"active"},
    {"id":"53000000-0000-4000-8000-000000000002","name":"Court 2","surface":"hard","is_indoor":false,"is_covered":false,"status":"inactive"},
    {"id":null,"name":"Court 3","surface":null,"is_indoor":false,"is_covered":true,"status":"active"}]');
select venues_test.assert_that((select data->>'name' = 'Alpha Pickleball Club' and data->>'address_line' = '1 Rizal Ave'
  and (data->>'latitude')::float8 = 14.6 and (data->>'longitude')::float8 = 121
  and data->>'publication_status' = 'approved' and data->>'claim_status' = 'verified'
  and (data->>'updated_at')::timestamptz > '2026-01-01T00:00:00Z'
  and (select jsonb_agg(jsonb_build_array(c->>'name', c->>'status') order by c->>'name') from jsonb_array_elements(data->'courts') c)
    = '[["Center Court","active"],["Court 2","inactive"],["Court 3","active"]]'::jsonb
  from venues_result where label = 'saved'), 'owner save updates details and courts, never the pin or statuses');
-- The version the owner loaded is now stale.
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','{"name":"Lost update","address_line":"A","city":"C","province":"P"}','[]','2026-01-01T00:00:00Z')$q$, '40001', 'version_conflict');
-- Omitted courts are untouched; an inactive court can be reactivated.
select venues_test.assert_that((select jsonb_array_length(venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
  '{"name":"Alpha Pickleball Club","address_line":"1 Rizal Ave","city":"Manila","province":"Metro Manila"}',
  '[{"id":"53000000-0000-4000-8000-000000000002","name":"Court 2","surface":"hard","is_indoor":false,"is_covered":false,"status":"active"}]')->'courts') = 3),
  'partial court save keeps omitted courts');
-- Another owner's save on their own venue is independent.
select venues_test.assert_that((venues_test.save('51000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000005',
  '{"name":"Gamma Courts","address_line":"5 Fixture St","city":"Cebu City","province":"Cebu"}','[]')->>'name') = 'Gamma Courts', 'owner B edits their own venue');
reset role;

-- Revocation takes effect at the next command.
select venues_test.assert_that((select count(*) = 1 from jsonb_array_elements(
  (select public.owner_venue_list('51000000-0000-4000-8000-000000000004'))) v where (v->>'editable')::boolean), 'linked owner before revocation');
delete from private.venue_owners where user_id = '51000000-0000-4000-8000-000000000004';
set local role service_role;
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000004','52000000-0000-4000-8000-000000000001','{"name":"Revoked","address_line":"A","city":"C","province":"P"}','[]')$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000004','52000000-0000-4000-8000-000000000001')$q$, '42501', 'not_owner');

-- Photos: own venue folder, server-measured dimensions, retry-safe, at most six.
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001',gen_random_uuid(),'52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',1200,900)$q$, '42501', 'not_owner');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000004',gen_random_uuid(),'52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',1200,900)$q$, 'P0002', 'venue_unavailable');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',null,'52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',1200,900)$q$, '22023', 'invalid_input');
select venues_test.expect_error(format($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid(),%L,%s,%s)$q$, ref, w, h), '22023', 'invalid_photo')
from (values
  ('52000000-0000-4000-8000-000000000002/54000000-0000-4000-8000-000000000011.jpg', 1200, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000031.jpg', 1200, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000098.jpg', 1200, 900),
  ('52000000-0000-4000-8000-000000000001/../54000000-0000-4000-8000-000000000001.jpg', 1200, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.gif', 1200, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg', 319, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg', 8193, 900),
  ('52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg', 6000, 5000)
) bad(ref, w, h);
insert into venues_result select 'photo', public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
  '55000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',1200,900);
select venues_test.assert_that((select data->>'outcome' = 'created' and jsonb_array_length(data->'venue'->'photos') = 1
  and data->'venue'->'photos'->0->>'storage_path' = '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg'
  and not (data->'venue'->'photos'->0 ?| array['uploaded_by','request_id'])
  from venues_result where label = 'photo'), 'photo added without uploader or request IDs');
select venues_test.assert_that((public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
  '55000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000002.png',800,800)->>'outcome') = 'existing',
  'retrying the same request returns the original photo');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002','55000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002/54000000-0000-4000-8000-000000000011.jpg',800,800)$q$, '23505', 'request_reused');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid(),'52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg',1200,900)$q$, '22023', 'invalid_photo');
select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid(),
  '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-00000000000' || n || case n when 2 then '.png' else '.jpg' end, 4000, 3000)
  from generate_series(2, 6) n;
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',gen_random_uuid(),'52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000007.jpg',1200,900)$q$, 'P0001', 'too_many_photos');
-- Removal is scoped to the venue and retry-safe.
select venues_test.assert_that((select r->>'removed_path' is null
  from public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002',
    (select id from public.venue_photos where storage_path like '%54000000-0000-4000-8000-000000000001.jpg')) r)
  and (select count(*) = 6 from public.venue_photos where venue_id = '52000000-0000-4000-8000-000000000001'), 'a photo cannot be removed through another venue');
select venues_test.expect_error($q$select public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000001',(select id from public.venue_photos limit 1))$q$, '42501', 'not_owner');
select venues_test.assert_that((select r->>'removed_path' = '52000000-0000-4000-8000-000000000001/54000000-0000-4000-8000-000000000001.jpg'
  and jsonb_array_length(r->'venue'->'photos') = 5
  from public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
    (select id from public.venue_photos where storage_path like '%54000000-0000-4000-8000-000000000001.jpg')) r), 'owner removes a photo');
select venues_test.assert_that((public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',
  '55000000-0000-4000-8000-000000000099')->>'removed_path') is null, 'removing a missing photo is a no-op');
select venues_test.expect_error($q$select * from private.venue_photo_requests$q$, '42501');
select venues_test.expect_error($q$delete from public.venue_photos$q$, '42501');
reset role;
select venues_test.assert_that((select count(*) = 5 from private.venue_photo_requests), 'removal also drops the request record');

-- Public reads: approved venues' photos only, never private request data.
insert into public.venue_photos(venue_id,storage_path,width,height) values
  ('52000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000003/54000000-0000-4000-8000-000000000041.jpg',800,600);
set local role anon;
select venues_test.assert_that((select count(*) = 5 and bool_and(venue_id = '52000000-0000-4000-8000-000000000001') from public.venue_photos),
  'guests see approved venues'' photos only');
reset role;
update public.venues set publication_status = 'suspended' where id = '52000000-0000-4000-8000-000000000001';
set local role anon;
select venues_test.assert_that((select count(*) = 0 from public.venue_photos), 'suspension hides photos');
reset role;
set local role service_role;
select venues_test.expect_error($q$select public.owner_venue_photo_remove('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001',(select id from public.venue_photos limit 1))$q$, 'P0002', 'venue_unavailable');
reset role;
update public.venues set publication_status = 'approved' where id = '52000000-0000-4000-8000-000000000001';

-- Audit: same transaction; a failing audit write aborts the edit.
create function venues_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end; $$;
create trigger venues_test_fail_audit before insert on private.directory_audit_events for each row execute function venues_test.fail_audit();
set local role service_role;
select venues_test.expect_error($q$select venues_test.save('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002','{"name":"Audit Failure","address_line":"A","city":"C","province":"P"}','[]')$q$, 'P0001');
select venues_test.expect_error($q$select public.owner_venue_photo_add('51000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000002',gen_random_uuid(),'52000000-0000-4000-8000-000000000002/54000000-0000-4000-8000-000000000011.jpg',800,800)$q$, 'P0001');
reset role;
drop trigger venues_test_fail_audit on private.directory_audit_events;
select venues_test.assert_that((select name = 'Owner Edit Beta' from public.venues where id = '52000000-0000-4000-8000-000000000002')
  and (select count(*) = 0 from public.venue_photos where venue_id = '52000000-0000-4000-8000-000000000002'), 'audit failure rolls back the edit');
select venues_test.assert_that((select jsonb_agg(jsonb_build_array(action, n) order by action) =
  '[["owner.photo_add",6],["owner.photo_remove",1],["owner.update",3]]'::jsonb
  from (select action, count(*) as n from private.directory_audit_events group by action) a), 'one audit row per successful edit');
select venues_test.assert_that((select array_agg(e->>'action' order by (e->>'id')::bigint) =
  array['owner.update','owner.update','owner.photo_add','owner.photo_add','owner.photo_add','owner.photo_add','owner.photo_add','owner.photo_add','owner.photo_remove']
  from jsonb_array_elements(public.directory_admin_audit_read('51000000-0000-4000-8000-000000000009','52000000-0000-4000-8000-000000000001')->'items') e),
  'admins read owner edits in the venue history');

-- Owner commands never change ownership, claim or publication state.
select venues_test.assert_that((select count(*) = 5 from private.venue_owners), 'owner links unchanged');
select venues_test.assert_that((select array_agg(publication_status::text || '/' || claim_status::text order by id) =
  array['approved/verified','approved/verified','draft/verified','suspended/verified','approved/verified','approved/unclaimed']
  from public.venues where id::text like '52000000-%'), 'publication and claim status unchanged');
select venues_test.assert_that((select latitude = 14.6 and longitude = 121 from public.venues where id = '52000000-0000-4000-8000-000000000001'), 'pin unchanged');
rollback;
