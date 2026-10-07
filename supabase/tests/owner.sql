-- Synthetic, rollback-only owner submission acceptance. Never run on hosted data.
begin;
create schema owner_test;
create function owner_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Owner assertion failed: %', message; end if; end;
$$;
-- Checks SQLSTATE and, when given, the machine-readable hint the server maps.
create function owner_test.expect_error(statement text, expected_code text, expected_hint text default null) returns void
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
grant usage on schema owner_test to anon, authenticated, service_role;
grant execute on all functions in schema owner_test to anon, authenticated, service_role;

insert into auth.users(id) values
  ('41000000-0000-4000-8000-000000000001'), ('41000000-0000-4000-8000-000000000002');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('42000000-0000-4000-8000-000000000001','Owner Alpha Courts','Fixture','Manila','Metro Manila',14.6,121,'approved','unclaimed'),
  ('42000000-0000-4000-8000-000000000002','Owner Verified','Fixture','Manila','Metro Manila',14.7,121.1,'approved','verified'),
  ('42000000-0000-4000-8000-000000000003','Owner Draft Nearby','Fixture','Manila','Metro Manila',14.6005,121.0005,'draft','unclaimed'),
  ('42000000-0000-4000-8000-000000000004','Owner Suspended Nearby','Fixture','Manila','Metro Manila',14.6001,121.0001,'suspended','unclaimed'),
  ('42000000-0000-4000-8000-000000000005','Owner Cebu Pending','Fixture','Cebu City','Cebu',10.3,123.9,'approved','pending');
-- Server-uploaded evidence objects (paths are server-chosen <user>/<uuid>.<ext>).
insert into storage.objects(bucket_id, name) select 'owner-evidence', p from unnest(array[
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000002.png',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000003.jpg',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000004.jpg',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000005.jpg',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000006.jpg',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000007.jpg',
  '41000000-0000-4000-8000-000000000002/43000000-0000-4000-8000-000000000011.jpg',
  '41000000-0000-4000-8000-000000000002/43000000-0000-4000-8000-000000000012.jpg']) p;

select owner_test.assert_that((select not public and file_size_limit = 5242880 and allowed_mime_types = array['image/jpeg','image/png']
  from storage.buckets where id = 'owner-evidence'), 'private, bounded evidence bucket');
select owner_test.assert_that(not exists(select 1 from pg_policies where schemaname = 'storage' and
  (qual ilike '%owner-evidence%' or with_check ilike '%owner-evidence%')), 'no client storage policy for evidence');

-- Client roles: no commands, no private tables, no evidence objects.
set local role anon;
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','x',null)$q$, '42501');
select owner_test.expect_error($q$select public.my_owner_submissions()$q$, '42501');
select owner_test.assert_that((select count(*) = 0 from storage.objects where bucket_id = 'owner-evidence'), 'anon reads no evidence');
reset role;
select set_config('request.jwt.claims', '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','x',null)$q$, '42501');
select owner_test.expect_error($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'{}','x',null,true)$q$, '42501');
select owner_test.expect_error($q$select public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',14.6,121,null)$q$, '42501');
select owner_test.expect_error($q$select * from private.venue_submissions$q$, '42501');
select owner_test.expect_error($q$select * from private.ownership_audit_events$q$, '42501');
select owner_test.expect_error($q$insert into private.venue_claims(venue_id,claimant_user_id,evidence_path) values ('42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','x')$q$, '42501');
select owner_test.assert_that((select count(*) = 0 from storage.objects where bucket_id = 'owner-evidence'), 'signed-in user cannot read or list evidence, even their own');
select owner_test.expect_error($q$insert into storage.objects(bucket_id,name) values ('owner-evidence','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000098.jpg')$q$, '42501');
select owner_test.assert_that((select count(*) = 0 from public.my_owner_submissions()), 'no submissions yet');
reset role;

-- Trusted server: actor checks, then audited claim commands.
set local role service_role;
select owner_test.expect_error($q$select public.owner_submit_claim(null,gen_random_uuid(),'42000000-0000-4000-8000-000000000001','x',null)$q$, '42501', 'actor_required');
select owner_test.expect_error($q$select public.owner_submit_claim('49000000-0000-4000-8000-000000000009',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','x',null)$q$, '42501', 'actor_required');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',null,'42000000-0000-4000-8000-000000000001','x',null)$q$, '22023', 'invalid_input');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',' padded ')$q$, '22023', 'invalid_input');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',E'bell\u0007')$q$, '22023', 'invalid_input');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000003','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',null)$q$, 'P0002', 'listing_unavailable');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000004','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',null)$q$, 'P0002', 'listing_unavailable');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),gen_random_uuid(),'41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',null)$q$, 'P0002', 'listing_unavailable');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000002','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',null)$q$, '23505', 'already_verified');
-- Evidence must be the actor's own uploaded object, in the private bucket.
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000002/43000000-0000-4000-8000-000000000011.jpg',null)$q$, '22023', 'invalid_evidence');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000097.jpg',null)$q$, '22023', 'invalid_evidence');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/../43000000-0000-4000-8000-000000000001.jpg',null)$q$, '22023', 'invalid_evidence');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.gif',null)$q$, '22023', 'invalid_evidence');

create temp table owner_result(label text primary key, data jsonb);
grant select, insert on owner_result to service_role;
insert into owner_result select 'claim', public.owner_submit_claim('41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg','I manage the front desk.');
select owner_test.assert_that((select data->>'outcome' = 'created' and data->'submission'->>'kind' = 'claim'
  and data->'submission'->>'status' = 'pending' and data->'submission'->>'name' = 'Owner Alpha Courts'
  and not (data->'submission' ?| array['evidence_path','note','claimant_user_id','request_id'])
  from owner_result where label = 'claim'), 'claim created with a minimal private-free summary');
select owner_test.assert_that((public.owner_submit_claim('41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg','I manage the front desk.')->>'outcome') = 'existing',
  'retry with the same request returns the original claim');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000005','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000002.png',null)$q$, '23505', 'request_reused');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000002.png',null)$q$, '23505', 'already_pending');
select owner_test.expect_error($q$select public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'42000000-0000-4000-8000-000000000005','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001.jpg',null)$q$, '23505', 'invalid_evidence');
-- Competing claimant: reviewers decide, so a second account may also claim.
select owner_test.assert_that((public.owner_submit_claim('41000000-0000-4000-8000-000000000002',gen_random_uuid(),
  '42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000002/43000000-0000-4000-8000-000000000011.jpg',null)->>'outcome') = 'created',
  'another account can claim the same listing');
select owner_test.assert_that((public.owner_submit_claim('41000000-0000-4000-8000-000000000001',gen_random_uuid(),
  '42000000-0000-4000-8000-000000000005','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000002.png',null)->>'outcome') = 'created',
  'a listing already under review can still be claimed');

-- New venue: input bounds.
select owner_test.expect_error(format($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),%L,'x',null,false)$q$, input), '22023', 'invalid_input')
from unnest(array[
  '{}', '[]',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":2,"status":"approved"}',
  '{"name":" X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":2}',
  '{"name":"","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":2}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":"14.6","longitude":121,"court_count":2}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":35.6,"longitude":139.7,"court_count":2}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":0}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":41}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":1.5}',
  '{"name":"X","address_line":"A","city":"C","province":"P","latitude":14.6,"longitude":121,"court_count":"2"}'
]::jsonb[]) input;

-- Duplicate warnings: approved listings only, with nothing written until acknowledged.
select owner_test.assert_that((select jsonb_agg(d->>'id') = '["42000000-0000-4000-8000-000000000001"]'::jsonb
  from jsonb_array_elements(public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',14.6003,121.0003,'Different name')) d),
  'nearby preview reveals approved listings only, never drafts/suspended');
select owner_test.assert_that(jsonb_array_length(public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',14.609,121,'Owner Alpha Courts')) = 1
  and jsonb_array_length(public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',14.609,121,'Riverside Pickle Club')) = 0
  and jsonb_array_length(public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',14.64,121,'Owner Alpha Courts')) = 0,
  'similar names match within 2 km only');
select owner_test.expect_error($q$select public.owner_duplicate_candidates('41000000-0000-4000-8000-000000000001',35.6,139.7,null)$q$, '22023', 'invalid_input');
insert into owner_result select 'warned', public.owner_submit_venue('41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000002','{"name":"Corner Courts","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila","latitude":14.6003,"longitude":121.0003,"court_count":3}',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000003.jpg',null,false);
select owner_test.assert_that((select data->>'outcome' = 'duplicates' and data->'submission' = 'null'::jsonb
  and jsonb_array_length(data->'duplicates') = 1 and data->'duplicates'->0->>'id' = '42000000-0000-4000-8000-000000000001'
  and (data->'duplicates'->0->>'distance_m')::integer between 30 and 60
  from owner_result where label = 'warned'), 'unacknowledged duplicate returns a warning');
reset role;
select owner_test.assert_that((select count(*) = 0 from private.venue_submissions), 'warning writes nothing');
set local role service_role;
insert into owner_result select 'venue', public.owner_submit_venue('41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000002','{"name":"Corner Courts","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila","latitude":14.6003,"longitude":121.0003,"court_count":3}',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000003.jpg','Opened last month.',true);
select owner_test.assert_that((select data->>'outcome' = 'created' and data->'submission'->>'kind' = 'venue'
  and data->'submission'->>'venue_id' is not null and jsonb_array_length(data->'duplicates') = 1
  from owner_result where label = 'venue'), 'acknowledged submission is created, names its draft and still lists the warning');
create temp table owner_draft as select (data->'submission'->>'venue_id')::uuid as id from owner_result where label = 'venue';
reset role;
select owner_test.assert_that((select v.publication_status = 'draft' and v.claim_status = 'pending' and v.name = 'Corner Courts'
  and (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active') = 3
  and s.venue_id = v.id and not exists (select 1 from private.venue_owners o where o.venue_id = v.id)
  and exists (select 1 from private.directory_audit_events a where a.target_venue_id = v.id and a.action = 'owner.create'
    and a.actor_user_id = '41000000-0000-4000-8000-000000000001')
  from owner_draft d join public.venues v on v.id = d.id join private.venue_submissions s on s.venue_id = v.id),
  'the submission creates a private draft with its courts, audited, and no owner link');
grant select on owner_draft to service_role, authenticated;
set local role service_role;
select owner_test.assert_that((public.owner_submit_venue('41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000002','{"name":"Corner Courts","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila","latitude":14.6003,"longitude":121.0003,"court_count":3}',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000003.jpg','Opened last month.',true)->>'outcome') = 'existing',
  'retried submission is idempotent');
select owner_test.expect_error($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'{"name":"Corner Courts again","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila","latitude":14.6004,"longitude":121.0004,"court_count":3}','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000004.jpg',null,true)$q$, '23505', 'already_pending');
select owner_test.expect_error($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001','44000000-0000-4000-8000-000000000001','{"name":"Reused","address_line":"A","city":"Manila","province":"Metro Manila","latitude":15.5,"longitude":121,"court_count":1}','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000004.jpg',null,true)$q$, '23505', 'request_reused');
-- Another account submitting nearby is recorded for reviewers, privately.
select owner_test.assert_that((public.owner_submit_venue('41000000-0000-4000-8000-000000000002',gen_random_uuid(),
  '{"name":"Corner Pickleball","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila","latitude":14.6004,"longitude":121.0004,"court_count":2}',
  '41000000-0000-4000-8000-000000000002/43000000-0000-4000-8000-000000000012.jpg',null,true)->'duplicates'->0->>'id') = '42000000-0000-4000-8000-000000000001',
  'second account sees only the public duplicate');
reset role;
select owner_test.assert_that((select nearby_venue_ids = array['42000000-0000-4000-8000-000000000001','42000000-0000-4000-8000-000000000003']::uuid[]
  and nearby_submission_ids = '{}' and duplicates_acknowledged and court_count = 3 and note = 'Opened last month.'
  from private.venue_submissions where submitter_user_id = '41000000-0000-4000-8000-000000000001'),
  'reviewer snapshot keeps approved and draft neighbours, not suspended');
select owner_test.assert_that((select nearby_submission_ids = array[(select id from private.venue_submissions where submitter_user_id = '41000000-0000-4000-8000-000000000001')]
  and (select id from owner_draft) = any(nearby_venue_ids)
  from private.venue_submissions where submitter_user_id = '41000000-0000-4000-8000-000000000002'), 'competing pending submission and its draft recorded for reviewers');

-- The creator sets the draft up while it is reviewed; nobody else can.
set local role service_role;
select owner_test.assert_that((select r->>'publication_status' = 'draft' and jsonb_array_length(r->'courts') = 3
  from owner_draft d, public.owner_venue_read('41000000-0000-4000-8000-000000000001', d.id) r), 'creator reads the draft');
select owner_test.expect_error(format($q$select public.owner_venue_read('41000000-0000-4000-8000-000000000002',%L)$q$, id), '42501', 'not_owner') from owner_draft;
select owner_test.assert_that((select r->>'name' = 'Corner Courts Annex' and jsonb_array_length(r->'courts') = 4
  from owner_draft d join public.venues v on v.id = d.id,
    public.owner_venue_save('41000000-0000-4000-8000-000000000001', d.id, v.updated_at,
      '{"name":"Corner Courts Annex","address_line":"12 Fixture St","city":"Manila","province":"Metro Manila"}',
      '[{"id":null,"name":"Court 4","surface":"hard","is_indoor":false,"is_covered":true,"status":"active"}]') r),
  'creator edits details and adds a court');
select owner_test.expect_error(format($q$select public.owner_venue_save('41000000-0000-4000-8000-000000000002',%L,now(),'{"name":"X","address_line":"A","city":"C","province":"P"}','[]')$q$, id), '42501', 'not_owner') from owner_draft;
select owner_test.assert_that((select r->>'venue_id' = d.id::text
  from owner_draft d, public.owner_venue_policy_read('41000000-0000-4000-8000-000000000001', d.id) r), 'creator reads booking policy');
select owner_test.assert_that((select jsonb_agg(x->>'id') = jsonb_build_array(d.id) and bool_and((x->>'editable')::boolean)
  and bool_and(x->>'publication_status' = 'draft')
  from owner_draft d, jsonb_array_elements(public.owner_venue_list('41000000-0000-4000-8000-000000000001')) x group by d.id),
  'venue list includes the draft under review as editable');
reset role;
select set_config('request.jwt.claims', '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select owner_test.assert_that((select owned_venue_ids = '{}' and pending_venue_ids = array[(select id from owner_draft)]
  from public.my_account_access()), 'a draft under review is pending, never an owned venue');
select owner_test.assert_that((select name = 'Corner Courts Annex' and venue_id = (select id from owner_draft)
  from public.my_owner_submissions() where kind = 'venue' and status = 'pending' and city = 'Manila'), 'submitter sees the draft by its current name');
select owner_test.assert_that((select count(*) = 0 from public.venues where name like 'Corner Courts%'), 'drafts stay out of public reads');
reset role;

-- Audit is part of the same transaction; a failing audit write aborts the command.
create function owner_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'audit unavailable'; end; $$;
create trigger owner_test_fail_audit before insert on private.ownership_audit_events for each row execute function owner_test.fail_audit();
set local role service_role;
select owner_test.expect_error($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'{"name":"Audit Failure Courts","address_line":"A","city":"Quezon City","province":"Metro Manila","latitude":14.65,"longitude":121.05,"court_count":1}','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000004.jpg',null,false)$q$, 'P0001');
reset role;
drop trigger owner_test_fail_audit on private.ownership_audit_events;
select owner_test.assert_that((select count(*) = 0 from private.venue_submissions where name = 'Audit Failure Courts')
  and (select count(*) = 0 from public.venues where name = 'Audit Failure Courts'), 'audit failure rolls back the submission and its draft');

-- Pending cap: claims + submissions, per account.
set local role service_role;
select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"name":"Cap Courts One","address_line":"A","city":"Quezon City","province":"Metro Manila","latitude":14.65,"longitude":121.05,"court_count":1}',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000004.jpg',null,false);
select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),
  '{"name":"Cap Courts Two","address_line":"A","city":"Pasig","province":"Metro Manila","latitude":14.57,"longitude":121.08,"court_count":1}',
  '41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000005.jpg',null,false);
select owner_test.expect_error($q$select public.owner_submit_venue('41000000-0000-4000-8000-000000000001',gen_random_uuid(),'{"name":"Cap Courts Three","address_line":"A","city":"Davao City","province":"Davao del Sur","latitude":7.07,"longitude":125.6,"court_count":1}','41000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000006.jpg',null,false)$q$, 'P0001', 'too_many_pending');
select owner_test.expect_error($q$insert into private.venue_claims(venue_id,claimant_user_id,evidence_path) values ('42000000-0000-4000-8000-000000000001','41000000-0000-4000-8000-000000000001','x')$q$, '42501');
select owner_test.expect_error($q$select * from private.venue_submissions$q$, '42501');
reset role;

-- Self-only status list.
select set_config('request.jwt.claims', '{"sub":"41000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select owner_test.assert_that((select count(*) = 2 and bool_and(status = 'pending') from public.my_owner_submissions()), 'second account sees its own two submissions');
reset role;
select set_config('request.jwt.claims', '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select owner_test.assert_that((select count(*) = 5 and count(*) filter (where kind = 'claim') = 2
  and count(*) filter (where kind = 'venue' and venue_id is not null) = 3 from public.my_owner_submissions()), 'own claims and submissions only');
reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select owner_test.expect_error($q$select public.my_owner_submissions()$q$, '42501');
reset role;

-- Submissions never publish, verify, link owners or grant roles; each new venue is one private draft.
select owner_test.assert_that((select count(*) = 4 and bool_and(publication_status = 'draft' and claim_status = 'pending')
  from public.venues where id::text not like '42000000-%'), 'one private draft per created submission, none published');
select owner_test.assert_that((select array_agg(claim_status::text order by id) = array['unclaimed','verified','unclaimed','unclaimed','pending']
  from public.venues where id::text like '42000000-%'), 'public claim status unchanged');
select owner_test.assert_that((select count(*) = 0 from private.venue_owners) and (select count(*) = 0 from private.account_roles), 'no ownership or role granted');
select owner_test.assert_that((select count(*) = 3 from private.venue_claims) and (select count(*) = 4 from private.venue_submissions), 'claims and submissions stored privately');
select owner_test.assert_that((select count(*) = 7 and count(*) filter (where action = 'claim.submit' and target_venue_id is not null) = 3
  and count(*) filter (where action = 'venue.submit' and target_venue_id is not null) = 4
  from private.ownership_audit_events), 'one audit event per created command, none for retries or warnings');
select owner_test.assert_that((select count(*) = 4 from private.directory_audit_events where action = 'owner.create'), 'one draft audit per created venue');
rollback;
