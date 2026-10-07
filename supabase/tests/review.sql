-- Synthetic, rollback-only ownership review acceptance (T17). Never run on hosted data.
begin;
create schema review_test;
create function review_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Review assertion failed: %', message; end if; end;
$$;
create function review_test.expect_error(statement text, expected_code text, expected_hint text default null) returns void
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
create function review_test.audits(audit_action text) returns integer language sql security definer as $$
  select count(*)::integer from private.ownership_audit_events where action = audit_action;
$$;
grant usage on schema review_test to anon, authenticated, service_role;
grant execute on all functions in schema review_test to anon, authenticated, service_role;

-- 51 admin, 52 moderator, 53 player claimant, 54 player submitter, 55 revoked moderator.
insert into auth.users(id) values
  ('51000000-0000-4000-8000-000000000051'), ('51000000-0000-4000-8000-000000000052'), ('51000000-0000-4000-8000-000000000053'),
  ('51000000-0000-4000-8000-000000000054'), ('51000000-0000-4000-8000-000000000055');
insert into private.account_roles(user_id, role) values
  ('51000000-0000-4000-8000-000000000051', 'admin'), ('51000000-0000-4000-8000-000000000052', 'moderator'),
  ('51000000-0000-4000-8000-000000000055', 'moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('52000000-0000-4000-8000-000000000001','Review Alpha','Fixture','Manila','Metro Manila',14.6,121,'approved','unclaimed'),
  ('52000000-0000-4000-8000-000000000002','Review Merge Target','Fixture','Manila','Metro Manila',14.65,121.05,'approved','unclaimed'),
  ('52000000-0000-4000-8000-000000000003','Review Suspended','Fixture','Manila','Metro Manila',14.7,121.1,'suspended','unclaimed'),
  ('52000000-0000-4000-8000-000000000004','Review Hidden Draft','Fixture','Cebu City','Cebu',10.3001,123.9001,'draft','unclaimed');
insert into public.courts(venue_id,name) select id, 'Court 1' from public.venues where id::text like '52000000-%';
-- The owners' private drafts behind the three new-venue submissions below.
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  ('52000000-0000-4000-8000-000000000011','Cebu New Courts','1 Fixture Rd','Cebu City','Cebu',10.3,123.9,'draft','pending'),
  ('52000000-0000-4000-8000-000000000012','Merge Me','2 Fixture Rd','Manila','Metro Manila',14.6501,121.0501,'draft','pending'),
  ('52000000-0000-4000-8000-000000000013','Cebu Rival','3 Fixture Rd','Cebu City','Cebu',10.3002,123.9002,'draft','pending');
insert into public.courts(venue_id,name) select '52000000-0000-4000-8000-000000000011', 'Court ' || n from generate_series(1, 3) n;
insert into public.courts(venue_id,name) select '52000000-0000-4000-8000-000000000012', 'Court ' || n from generate_series(1, 2) n;
insert into public.courts(venue_id,name) values ('52000000-0000-4000-8000-000000000013', 'Court 1');
-- Pending records as T15 commands leave them (direct fixture inserts as the owner role).
insert into private.venue_claims(id, venue_id, claimant_user_id, evidence_path, created_at) values
  ('53000000-0000-4000-8000-000000000001','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000053',
   '51000000-0000-4000-8000-000000000053/53000000-0000-4000-8000-0000000000e1.jpg', '2026-10-01T01:00:00Z'),
  ('53000000-0000-4000-8000-000000000002','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000054',
   '51000000-0000-4000-8000-000000000054/53000000-0000-4000-8000-0000000000e2.jpg', '2026-10-01T02:00:00Z'),
  ('53000000-0000-4000-8000-000000000003','52000000-0000-4000-8000-000000000003','51000000-0000-4000-8000-000000000053',
   '51000000-0000-4000-8000-000000000053/53000000-0000-4000-8000-0000000000e3.png', '2026-10-01T03:00:00Z'),
  ('53000000-0000-4000-8000-000000000004','52000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000052',
   '51000000-0000-4000-8000-000000000052/53000000-0000-4000-8000-0000000000e4.jpg', '2026-10-01T04:00:00Z');
insert into private.venue_submissions(id, submitter_user_id, request_id, name, address_line, city, province, latitude, longitude,
  court_count, evidence_path, duplicates_acknowledged, nearby_venue_ids, nearby_submission_ids, created_at, venue_id) values
  ('54000000-0000-4000-8000-000000000001','51000000-0000-4000-8000-000000000054',gen_random_uuid(),'Cebu New Courts','1 Fixture Rd',
   'Cebu City','Cebu',10.3,123.9,3,'51000000-0000-4000-8000-000000000054/54000000-0000-4000-8000-0000000000e1.jpg',true,
   array['52000000-0000-4000-8000-000000000004']::uuid[],'{}','2026-10-02T01:00:00Z','52000000-0000-4000-8000-000000000011'),
  ('54000000-0000-4000-8000-000000000002','51000000-0000-4000-8000-000000000053',gen_random_uuid(),'Merge Me','2 Fixture Rd',
   'Manila','Metro Manila',14.6501,121.0501,2,'51000000-0000-4000-8000-000000000053/54000000-0000-4000-8000-0000000000e2.jpg',true,
   '{}','{}','2026-10-02T02:00:00Z','52000000-0000-4000-8000-000000000012'),
  ('54000000-0000-4000-8000-000000000003','51000000-0000-4000-8000-000000000053',gen_random_uuid(),'Cebu Rival','3 Fixture Rd',
   'Cebu City','Cebu',10.3002,123.9002,1,'51000000-0000-4000-8000-000000000053/54000000-0000-4000-8000-0000000000e3.jpg',false,
   '{}',array['54000000-0000-4000-8000-000000000001']::uuid[],'2026-10-02T03:00:00Z','52000000-0000-4000-8000-000000000013');
select review_test.assert_that((select count(*) = 0 from private.venue_submissions where status = 'pending' and venue_id is null),
  'every pending new-venue submission has its draft');

-- Client roles: no review commands, no private review data.
set local role anon;
select review_test.expect_error($q$select public.ownership_review_queue('51000000-0000-4000-8000-000000000051')$q$, '42501');
reset role;
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000051","role":"authenticated"}', true);
set local role authenticated;
select review_test.expect_error($q$select public.ownership_review_queue('51000000-0000-4000-8000-000000000051')$q$, '42501');
select review_test.expect_error($q$select public.ownership_review_read('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000001')$q$, '42501');
select review_test.expect_error($q$select public.ownership_review_evidence('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000001')$q$, '42501');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000001','approve',null,null)$q$, '42501');
select review_test.expect_error($q$select * from private.venue_claims$q$, '42501');
reset role;

set local role service_role;
-- The infrastructure credential is not a reviewer: the verified actor must be.
select review_test.expect_error($q$select public.ownership_review_queue(null)$q$, '42501', 'reviewer_required');
select review_test.expect_error($q$select public.ownership_review_queue('51000000-0000-4000-8000-000000000053')$q$, '42501', 'reviewer_required');
select review_test.expect_error($q$select public.ownership_review_evidence('51000000-0000-4000-8000-000000000053','53000000-0000-4000-8000-000000000001')$q$, '42501', 'reviewer_required');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000053','53000000-0000-4000-8000-000000000002','approve',null,null)$q$, '42501', 'reviewer_required');
select review_test.expect_error($q$select public.ownership_review_queue('51000000-0000-4000-8000-000000000052','2026-10-01T00:00:00Z',null)$q$, '22023', 'invalid_input');

-- Queue: oldest first across claims and new venues, with duplicate signals.
select review_test.assert_that((select jsonb_array_length(q -> 'items') = 7 and (q ->> 'pending_total')::integer = 7
  and q -> 'next_cursor' = 'null'::jsonb and q -> 'items' -> 0 ->> 'id' = '53000000-0000-4000-8000-000000000001'
  and q -> 'items' -> 4 ->> 'kind' = 'venue' and (q -> 'items' -> 0 ->> 'duplicate_signals')::integer = 2
  and (q -> 'items' -> 6 ->> 'duplicate_signals')::integer = 1 and not (q::text ~ 'evidence|e1[.]jpg|note')
  from public.ownership_review_queue('51000000-0000-4000-8000-000000000052') q), 'pending queue order, signals, no evidence');
-- Keyset paging past 50 items.
reset role;
with drafts as (
  insert into public.venues(name, address_line, city, province, latitude, longitude, publication_status, claim_status)
  select 'Paging ' || n, 'Fixture', 'Davao City', 'Davao del Sur', 7 + n * 0.01, 125.5, 'draft', 'pending' from generate_series(1, 50) n
  returning id, name)
insert into private.venue_submissions(submitter_user_id, request_id, name, address_line, city, province, latitude, longitude,
  court_count, evidence_path, duplicates_acknowledged, created_at, venue_id)
select '51000000-0000-4000-8000-000000000055', gen_random_uuid(), 'Paging ' || n, 'Fixture', 'Davao City', 'Davao del Sur',
  7 + n * 0.01, 125.5, 1, '51000000-0000-4000-8000-000000000055/' || gen_random_uuid() || '.jpg', false,
  '2026-10-03T00:00:00Z'::timestamptz + n * interval '1 minute', d.id
from generate_series(1, 50) n join drafts d on d.name = 'Paging ' || n;
set local role service_role;
create temporary table review_page on commit drop as
  select public.ownership_review_queue('51000000-0000-4000-8000-000000000051') as q;
select review_test.assert_that((select jsonb_array_length(q -> 'items') = 50 and (q ->> 'pending_total')::integer = 57
  and q -> 'next_cursor' ->> 'id' = q -> 'items' -> 49 ->> 'id' from review_page), 'first page and cursor');
select review_test.assert_that((select jsonb_array_length(n -> 'items') = 7 and n -> 'next_cursor' = 'null'::jsonb
  and n -> 'items' -> 6 ->> 'name' = 'Paging 50'
  from review_page p, public.ownership_review_queue('51000000-0000-4000-8000-000000000051',
    (p.q -> 'next_cursor' ->> 'created_at')::timestamptz, (p.q -> 'next_cursor' ->> 'id')::uuid) n), 'second page');
reset role;
delete from private.venue_submissions where submitter_user_id = '51000000-0000-4000-8000-000000000055';
delete from public.venues where name like 'Paging %';
set local role service_role;

-- Detail: reviewer context including drafts and other pending submissions, never evidence paths.
select review_test.assert_that((select r ->> 'kind' = 'claim' and r -> 'venue' ->> 'claim_status' = 'unclaimed'
  and (r ->> 'other_pending_claims')::integer = 2 and r -> 'submitter' ->> 'id' = '51000000-0000-4000-8000-000000000053'
  and (r -> 'submitter' ->> 'pending')::integer = 4 and r -> 'review' = 'null'::jsonb and not (r::text ~ 'e1[.]jpg')
  from public.ownership_review_read('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001') r), 'claim detail');
select review_test.assert_that((select r ->> 'kind' = 'venue' and (r -> 'proposed' ->> 'court_count')::integer = 3
  and r -> 'draft' ->> 'id' = '52000000-0000-4000-8000-000000000011' and r -> 'draft' ->> 'publication_status' = 'draft'
  and (r -> 'draft' ->> 'active_court_count')::integer = 3
  and not exists (select 1 from jsonb_array_elements(r -> 'nearby_venues') n where n ->> 'id' = '52000000-0000-4000-8000-000000000011')
  and r -> 'nearby_venues' -> 0 ->> 'id' = '52000000-0000-4000-8000-000000000004'
  and r -> 'nearby_venues' -> 0 ->> 'publication_status' = 'draft' and (r -> 'nearby_venues' -> 0 ->> 'in_snapshot')::boolean
  and r -> 'nearby_submissions' -> 0 ->> 'id' = '54000000-0000-4000-8000-000000000003'
  and not (r -> 'nearby_submissions' -> 0 ->> 'in_snapshot')::boolean and not (r::text ~ 'e1[.]jpg')
  from public.ownership_review_read('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000001') r), 'venue detail with duplicates');
select review_test.expect_error($q$select public.ownership_review_read('51000000-0000-4000-8000-000000000052',gen_random_uuid())$q$, 'P0002', 'not_found');
select review_test.assert_that(public.ownership_review_evidence('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000001')
  = '51000000-0000-4000-8000-000000000054/54000000-0000-4000-8000-0000000000e1.jpg', 'evidence path for the trusted server');
select review_test.expect_error($q$select public.ownership_review_evidence('51000000-0000-4000-8000-000000000052',gen_random_uuid())$q$, 'P0002', 'not_found');

-- Decision shape.
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','reject',null,null)$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','approve',null,'other')$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','reject',null,'rude')$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','merge',null,null)$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','approve_new',null,null)$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','54000000-0000-4000-8000-000000000001','approve_new',null,null)$q$, '22023', 'invalid_input');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052',gen_random_uuid(),'approve',null,null)$q$, 'P0002', 'not_found');
-- Nobody decides their own submission.
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000004','approve',null,null)$q$, '42501', 'self_review');

-- Moderator approves a claim: verified listing, owner link, one audit row; retries return existing.
select review_test.assert_that((select d ->> 'outcome' = 'decided' and d -> 'item' ->> 'status' = 'approved'
  and d -> 'item' -> 'venue' ->> 'claim_status' = 'verified' and (d -> 'item' -> 'venue' ->> 'owner_count')::integer = 1
  and d -> 'item' -> 'review' ->> 'reviewed_by' = '51000000-0000-4000-8000-000000000052'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000052','53000000-0000-4000-8000-000000000001','approve',null,null) d), 'claim approved');
select review_test.assert_that((select d ->> 'outcome' = 'existing'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000001','approve',null,null) d), 'approve retry');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000001','reject',null,'other')$q$, '23505', 'already_decided');
select review_test.assert_that(review_test.audits('claim.approve') = 1, 'one approval audit');
reset role;
select review_test.assert_that((select verified_by = '51000000-0000-4000-8000-000000000052' from private.venue_owners
  where venue_id = '52000000-0000-4000-8000-000000000001' and user_id = '51000000-0000-4000-8000-000000000053'), 'owner linked by reviewer');
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000053","role":"authenticated"}', true);
set local role authenticated;
select review_test.assert_that((select owned_venue_ids = array['52000000-0000-4000-8000-000000000001']::uuid[]
  from public.my_account_access()), 'claimant now manages the approved listing');
select review_test.assert_that((select status = 'approved' and venue_id = '52000000-0000-4000-8000-000000000001'
  from public.my_owner_submissions() where id = '53000000-0000-4000-8000-000000000001'), 'claimant sees approval');
select review_test.assert_that((select claim_status = 'verified' from public.venues where id = '52000000-0000-4000-8000-000000000001'), 'public verified badge');
reset role;
set local role service_role;

-- Competing claim rejected; listing stays verified. Suspended listings cannot gain owners.
select review_test.assert_that((select d -> 'item' ->> 'status' = 'rejected' and d -> 'item' -> 'review' ->> 'reason' = 'not_owner'
  and d -> 'item' -> 'venue' ->> 'claim_status' = 'verified'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000002','reject',null,'not_owner') d), 'competing claim rejected');
select review_test.assert_that((select d ->> 'outcome' = 'existing'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000002','reject',null,'not_owner') d), 'reject retry');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','53000000-0000-4000-8000-000000000003','approve',null,null)$q$, 'P0002', 'listing_unavailable');
select review_test.assert_that(review_test.audits('claim.reject') = 1, 'one rejection audit');

-- New venue approved: admin only; publishes the owner's draft and links them.
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000001','approve',null,null)$q$, '42501', 'admin_required');
select review_test.assert_that((select publication_status = 'draft' from public.venues where id = '52000000-0000-4000-8000-000000000011')
  and not exists (select 1 from private.venue_owners where user_id = '51000000-0000-4000-8000-000000000054'), 'failed approval changed nothing');
select review_test.assert_that((select r ->> 'publication_status' = 'draft'
  from public.owner_venue_read('51000000-0000-4000-8000-000000000054','52000000-0000-4000-8000-000000000011') r), 'creator sets up the draft while it is reviewed');
create temporary table review_new on commit drop as
  select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','54000000-0000-4000-8000-000000000001','approve',null,null) as d;
grant select on review_new to authenticated;
select review_test.assert_that((select d ->> 'outcome' = 'decided' and d -> 'item' -> 'review' ->> 'resolution' = 'new'
  and d -> 'item' -> 'review' ->> 'resolved_venue_id' = '52000000-0000-4000-8000-000000000011'
  and d -> 'item' -> 'draft' ->> 'publication_status' = 'approved' from review_new), 'submission approved as its own listing');
reset role;
select review_test.assert_that((select v.publication_status = 'approved' and v.claim_status = 'verified' and v.name = 'Cebu New Courts'
  and (select count(*) from public.courts c where c.venue_id = v.id and c.status = 'active') = 3
  and exists (select 1 from private.venue_owners o where o.venue_id = v.id and o.user_id = '51000000-0000-4000-8000-000000000054'
    and o.verified_by = '51000000-0000-4000-8000-000000000051')
  and exists (select 1 from private.directory_audit_events a where a.target_venue_id = v.id and a.action = 'directory.publish'
    and a.actor_user_id = '51000000-0000-4000-8000-000000000051')
  and exists (select 1 from private.ownership_audit_events a where a.target_venue_id = v.id and a.action = 'venue.approve')
  from public.venues v where v.id = '52000000-0000-4000-8000-000000000011'), 'draft published, owner linked, both audits');
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000054","role":"authenticated"}', true);
set local role authenticated;
select review_test.assert_that((select owned_venue_ids = array['52000000-0000-4000-8000-000000000011']::uuid[] and pending_venue_ids = '{}'
  from public.my_account_access()), 'the approved creator now owns the listing');
select review_test.assert_that((select s.venue_id = '52000000-0000-4000-8000-000000000011' and s.status = 'approved'
  from public.my_owner_submissions() s where s.id = '54000000-0000-4000-8000-000000000001'), 'submitter sees the approved listing');
select review_test.assert_that((select count(*) = 1 from public.venues where name = 'Cebu New Courts'), 'approved listing is public');
select review_test.assert_that(not exists(select 1 from public.my_owner_submissions() s where to_jsonb(s)::text ~ 'e1[.]jpg|nearby|52000000-0000-4000-8000-000000000004'),
  'submitter never sees evidence or reviewer duplicate snapshot');
reset role;
set local role service_role;
select review_test.assert_that((select d ->> 'outcome' = 'existing'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000051','54000000-0000-4000-8000-000000000001','approve',null,null) d), 'approve retry');
select review_test.assert_that(review_test.audits('venue.approve') = 1, 'retry adds no audit');

-- Publishing needs an active court, even after an admin changed the draft's courts.
reset role;
update public.courts set status = 'inactive' where venue_id = '52000000-0000-4000-8000-000000000013';
set local role service_role;
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000051','54000000-0000-4000-8000-000000000003','approve',null,null)$q$, '22023', 'active_court_required');

-- Duplicate resolution: merge into an existing listing (moderators may); the draft retires.
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge','52000000-0000-4000-8000-000000000003',null)$q$, 'P0002', 'listing_unavailable');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge',gen_random_uuid(),null)$q$, 'P0002', 'listing_unavailable');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge','52000000-0000-4000-8000-000000000012',null)$q$, '22023', 'invalid_input');
select review_test.assert_that((select d -> 'item' -> 'review' ->> 'resolution' = 'merge'
  and d -> 'item' -> 'review' ->> 'resolved_venue_id' = '52000000-0000-4000-8000-000000000002'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge','52000000-0000-4000-8000-000000000002',null) d), 'merged');
select review_test.assert_that((select d ->> 'outcome' = 'existing'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge','52000000-0000-4000-8000-000000000002',null) d), 'merge retry');
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000002','merge','52000000-0000-4000-8000-000000000001',null)$q$, '23505', 'already_decided');
select review_test.expect_error($q$select public.owner_venue_read('51000000-0000-4000-8000-000000000053','52000000-0000-4000-8000-000000000012')$q$, 'P0002', 'venue_unavailable');
reset role;
select review_test.assert_that((select v.claim_status = 'verified' and exists(select 1 from private.venue_owners o
  where o.venue_id = v.id and o.user_id = '51000000-0000-4000-8000-000000000053') from public.venues v
  where v.id = '52000000-0000-4000-8000-000000000002'), 'merge verifies and links the existing listing');
select review_test.assert_that((select publication_status = 'suspended' and claim_status = 'unclaimed'
  and not exists (select 1 from private.venue_owners o where o.venue_id = v.id)
  and exists (select 1 from private.directory_audit_events a where a.target_venue_id = v.id and a.action = 'directory.suspend'
    and a.actor_user_id = '51000000-0000-4000-8000-000000000052')
  from public.venues v where v.id = '52000000-0000-4000-8000-000000000012'), 'merged draft retired, unowned and audited');
set local role service_role;
select review_test.assert_that((select d -> 'item' -> 'review' ->> 'reason' = 'duplicate'
  from public.ownership_review_decide('51000000-0000-4000-8000-000000000052','54000000-0000-4000-8000-000000000003','reject',null,'duplicate') d), 'rival rejected as duplicate');
reset role;
select review_test.assert_that((select publication_status = 'suspended' and claim_status = 'unclaimed'
  from public.venues where id = '52000000-0000-4000-8000-000000000013'), 'rejected draft retired');
select set_config('request.jwt.claims', '{"sub":"51000000-0000-4000-8000-000000000053","role":"authenticated"}', true);
set local role authenticated;
select review_test.assert_that((select pending_venue_ids = '{}' from public.my_account_access()), 'retired drafts are no longer pending');
select review_test.assert_that((select venue_id is null and status = 'rejected' from public.my_owner_submissions()
  where id = '54000000-0000-4000-8000-000000000003'), 'a rejected submission names no listing');
reset role;

-- Revocation takes effect on the next command.
reset role;
delete from private.account_roles where user_id = '51000000-0000-4000-8000-000000000055';
set local role service_role;
select review_test.expect_error($q$select public.ownership_review_decide('51000000-0000-4000-8000-000000000055','53000000-0000-4000-8000-000000000003','reject',null,'other')$q$, '42501', 'reviewer_required');
select review_test.assert_that((select (q ->> 'pending_total')::integer = 2
  from public.ownership_review_queue('51000000-0000-4000-8000-000000000051') q), 'two items still pending');
select review_test.assert_that(review_test.audits('venue.approve') = 1 and review_test.audits('venue.merge') = 1
  and review_test.audits('venue.reject') = 1 and review_test.audits('claim.approve') = 1 and review_test.audits('claim.reject') = 1,
  'one audit row per decision');
reset role;
select review_test.assert_that((select target_venue_id = '52000000-0000-4000-8000-000000000013' from private.ownership_audit_events
  where action = 'venue.reject'), 'a venue rejection names the retired draft');
rollback;
