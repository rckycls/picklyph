-- Synthetic, rollback-only discovery acceptance. No hosted fixture writes.
begin;
create schema search_test;
create function search_test.assert_that(ok boolean, message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Search assertion failed: %', message; end if; end;
$$;
grant usage on schema search_test to anon, authenticated, service_role;
insert into public.venues (id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
 ('00000000-0000-4000-8000-000000000001','Search Alpha','Fixture address','Manila','Metro Manila',14.6,121,'approved','unclaimed'),
 ('00000000-0000-4000-8000-000000000002','Search 50%_\\ Literal','Fixture address','Manila','Metro Manila',15,122,'approved','verified'),
 ('00000000-0000-4000-8000-000000000003','Search Cebu','Fixture address','Cebu City','Cebu',10.3,123.9,'approved','pending'),
 ('00000000-0000-4000-8000-000000000004','Search Draft','Fixture address','Manila','Metro Manila',14.6,121,'draft','unclaimed'),
 ('00000000-0000-4000-8000-000000000005','Search Suspended','Fixture address','Manila','Metro Manila',14.6,121,'suspended','verified');
insert into public.courts(venue_id,name,status,is_indoor,is_covered,surface) values
 ('00000000-0000-4000-8000-000000000001','Indoor','active',true,false,'hard'),
 ('00000000-0000-4000-8000-000000000001','Covered','active',false,true,'synthetic'),
 ('00000000-0000-4000-8000-000000000001','Inactive','inactive',true,true,'hard'),
 ('00000000-0000-4000-8000-000000000002','Both','active',true,true,'hard'),
 ('00000000-0000-4000-8000-000000000004','Private','active',true,true,'hard');
set local role anon;
do $$begin
  begin perform public.directory_search('{"city":"Manila"}'); raise exception 'anon bypass'; exception when insufficient_privilege then null; end;
end;$$;
set local role authenticated;
do $$begin
  begin perform public.directory_search('{"city":"Manila"}'); raise exception 'authenticated bypass'; exception when insufficient_privilege then null; end;
end;$$;
set local role service_role;
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"mAnIlA"}')->'venues')=2, 'case-insensitive exact city, approved-only');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Man"}')->'venues')=0, 'city is exact');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"bounds":{"south":14,"west":120,"north":15,"east":122}}')->'venues')=2, 'inclusive spatial bounds');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"bounds":{"south":10,"west":123,"north":11,"east":124}}')->'venues')=1, 'Cebu nationwide');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Cebu City","bounds":{"south":14,"west":120,"north":15,"east":122}}')->'venues')=0, 'selectors intersect');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"name":"50%_"}')->'venues')=1, 'name metacharacters literal');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Manila","indoor":true,"covered":true,"surface":"hard"}')->'venues')=1, 'all filters match same active court');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Manila","indoor":false,"covered":true,"surface":"synthetic"}')->'venues')=1, 'false filter supported');
select search_test.assert_that((public.directory_search('{"city":"Manila","limit":1}')->'venues'->0->>'active_court_count')::integer=2, 'only active court count');
select search_test.assert_that(public.directory_search('{"city":"Manila","limit":1}')->>'next_cursor'='00000000-0000-4000-8000-000000000001', 'cursor is last returned ID, with lookahead');
select search_test.assert_that(public.directory_search('{"city":"Manila","limit":1,"after":"00000000-0000-4000-8000-000000000001"}')->>'next_cursor' is null, 'last page ends');
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Manila","after":"00000000-0000-4000-8000-000000000002"}')->'venues')=0, 'empty page after end');
select search_test.assert_that(not (public.directory_search('{"city":"Manila"}')->'venues'->0 ?| array['publication_status','created_at','location','claimant_user_id','evidence_path']), 'only explicit public projections');
do $$declare input jsonb; begin
  foreach input in array array['{}'::jsonb,'[]','{"city":"M"}','{"name":"ab"}','{"city":"Manila","limit":51}',
    '{"city":"Manila","limit":0}','{"city":"Manila","limit":null}','{"city":"Manila","limit":"25"}',
    '{"city":"Manila","limit":1.5}','{"city":"Manila","indoor":"true"}','{"city":"Manila","surface":"clay"}',
    '{"city":"Manila","after":"not-uuid"}','{"city":"Manila","unexpected":1}','{"bounds":{"south":0,"west":0,"north":31,"east":1}}',
    '{"bounds":{"south":0,"west":170,"north":1,"east":-170}}','{"bounds":{"south":null,"west":0,"north":1,"east":1}}',
    '{"bounds":{"south":0,"west":0,"north":1}}','{"bounds":{"south":"0","west":0,"north":1,"east":1}}'] loop
    begin perform public.directory_search(input); raise exception 'Invalid query accepted: %',input; exception when invalid_parameter_value then null; end;
  end loop;
end;$$;
reset role;
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status)
 select ('10000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid,'Search cap','Fixture','Cap City','Fixture',14,121,'approved' from generate_series(1,55) i;
set local role service_role;
select search_test.assert_that(jsonb_array_length(public.directory_search('{"city":"Cap City","limit":50}')->'venues')=50, 'hard page cap');
select search_test.assert_that(jsonb_array_length(public.directory_search(jsonb_build_object('city','Cap City','limit',50,'after', public.directory_search('{"city":"Cap City","limit":50}')->>'next_cursor'))->'venues')=5, 'keyset pages neither omit nor duplicate');
reset role;
rollback;
