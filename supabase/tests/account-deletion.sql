-- Rollback-only T47 fixtures: account deletion (console refusal, upcoming bookings, name erasure,
-- venue release, draft retirement, in-progress insert guards, Auth cascades) and report retention.
begin;
create schema del_test;
create function del_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Deletion assertion failed: %',message; end if; end; $$;
create function del_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
create function del_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function del_test.u(n text) returns uuid language sql immutable as $$ select ('c4710000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function del_test.v(n text) returns uuid language sql immutable as $$ select ('c4720000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function del_test.c(n text) returns uuid language sql immutable as $$ select ('c4730000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function del_test.k(n text) returns uuid language sql immutable as $$ select ('c4750000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function del_test.quote(actor text,court text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_quote(del_test.u(actor),del_test.c(court),del_test.at(a),del_test.at(b))->'expected_quote'; $$;
create function del_test.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(del_test.u(actor),del_test.c(court),del_test.k(request),del_test.at(a),del_test.at(b),del_test.quote(actor,court,a,b)); $$;
create function del_test.session(request text,court text,a integer,b integer) returns jsonb language sql as $$
select public.owner_session_create(del_test.u('1'),jsonb_build_object('venue_id',del_test.v('1'),'request_id',del_test.k(request),
  'court_ids',jsonb_build_array(del_test.c(court)),'title','Deletion play','starts_at',del_test.at(a),'ends_at',del_test.at(b),
  'capacity',8,'group_limit',4,'price_centavos',25000)); $$;
create function del_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=del_test.k(request); $$;
create function del_test.group_input(session text,request text,names jsonb) returns jsonb language sql as $$
select jsonb_build_object('session_id',del_test.sid(session),'request_id',del_test.k(request),'participants',names,
  'expected_total_centavos',25000*jsonb_array_length(names)); $$;
create function del_test.grp(actor text,session text,request text,names jsonb) returns jsonb language sql as $$
select public.session_booking_request(del_test.u(actor),del_test.group_input(session,request,names)); $$;
create function del_test.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=del_test.k(request); $$;
create function del_test.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=del_test.k(request); $$;
create function del_test.rental(request text) returns text language sql security definer set search_path='' as $$
select b.status||'/'||a.state from private.rental_bookings b join private.court_allocations a on a.id=b.id where a.request_id=del_test.k(request); $$;
create function del_test.allocation(request text) returns text language sql security definer set search_path='' as $$
select kind||'/'||state from private.court_allocations where request_id=del_test.k(request); $$;
create function del_test.rental_events(request text) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(e.action||':'||coalesce((e.actor_user_id=a.requested_by)::text,'null'),',' order by e.id),'')
from private.rental_events e join private.court_allocations a on a.id=e.booking_id where a.request_id=del_test.k(request); $$;
create function del_test.grp_state(request text) returns text language sql security definer set search_path='' as $$
select status||':'||participants::text from private.session_bookings where request_id=del_test.k(request); $$;
create function del_test.grp_input(request text) returns jsonb language sql security definer set search_path='' as $$
select request_input from private.session_bookings where request_id=del_test.k(request); $$;
create function del_test.grp_events(request text) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(e.action,',' order by e.id),'') from private.session_booking_events e
join private.session_bookings b on b.id=e.booking_id where b.request_id=del_test.k(request); $$;
create function del_test.reserved(request text) returns integer language sql security definer set search_path='' as $$
select reserved_spots from private.open_play_sessions where request_id=del_test.k(request); $$;
create function del_test.status(venue uuid) returns text language sql security definer set search_path='' as $$
select publication_status::text||'/'||claim_status::text from public.venues where id=venue; $$;
create function del_test.revocations(venue uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(action||':'||reason||':'||(actor_user_id=subject_id)::text,',' order by id),'')
from private.moderation_audit_events where target_venue_id=venue; $$;
create function del_test.directory_audit(venue uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(action||':'||actor_user_id::text,',' order by id),'') from private.directory_audit_events
where target_venue_id=venue and action='directory.suspend'; $$;
create function del_test.deleting(n text) returns boolean language sql security definer set search_path='' as $$
select exists(select 1 from private.account_deletions where user_id=del_test.u(n)); $$;
create function del_test.report_details(request text) returns text language sql security definer set search_path='' as $$
select coalesce(details,'<null>') from private.venue_reports where request_id=del_test.k(request); $$;
-- Trusted SQL only: stand in for operator policy.
create function del_test.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(del_test.v('1'),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
grant usage on schema del_test to anon,authenticated,service_role;
grant execute on all functions in schema del_test to anon,authenticated,service_role;

-- u1 owns V1 alone and V2 with u6, has a pending new-venue draft V3 and a pending claim on V4;
-- u5 is an admin; u2, u3 and u7 are players.
insert into auth.users(id) select del_test.u(n::text) from generate_series(1,8) n;
insert into private.account_roles(user_id,role) values (del_test.u('5'),'admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (del_test.v('1'),'Deletion Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  (del_test.v('2'),'Shared Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  (del_test.v('3'),'Draft Fixture','Fixture','Manila','Metro Manila',14.6,121,'draft','pending'),
  (del_test.v('4'),'Claimable Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','unclaimed');
insert into public.courts(id,venue_id,name,status) select del_test.c(n::text),del_test.v('1'),chr(64+n),'active' from generate_series(1,3) n;
insert into private.venue_owners(user_id,venue_id) values (del_test.u('1'),del_test.v('1')),(del_test.u('1'),del_test.v('2')),(del_test.u('6'),del_test.v('2'));
insert into private.venue_submissions(submitter_user_id,request_id,name,address_line,city,province,latitude,longitude,court_count,
  evidence_path,duplicates_acknowledged,venue_id)
  values (del_test.u('1'),del_test.k('90'),'Draft Fixture','Fixture','Manila','Metro Manila',14.6,121,1,del_test.u('1')||'/draft.jpg',true,del_test.v('3'));
insert into private.venue_claims(venue_id,claimant_user_id,evidence_path,request_id)
  values (del_test.v('4'),del_test.u('1'),del_test.u('1')||'/claim.jpg',del_test.k('91'));
select public.venue_schedule_save(del_test.u('1'),del_test.v('1'),null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));

set local role service_role;
-- Instant arrival policy: confirmed rentals, groups, an owner entry, a block and a walk-in.
select del_test.assert_that(del_test.rent('2','1','10',600,660)->'booking'->>'status'='confirmed','R1 u2 confirmed');
select del_test.assert_that(del_test.rent('3','1','11',660,720)->'booking'->>'status'='confirmed','R4 u3 confirmed');
select del_test.assert_that(public.rental_booking_owner_entry(del_test.u('1'),del_test.c('2'),del_test.k('12'),del_test.at(600),del_test.at(660),
  'Walk-up guest',del_test.quote('1','2',600,660))->'booking'->>'status'='confirmed','owner entry');
select del_test.assert_that(public.court_allocation_block(del_test.u('1'),del_test.c('2'),del_test.k('13'),del_test.at(720),del_test.at(780))->>'outcome'='created','block');
select del_test.assert_that(del_test.rent('2','3','14',600,660)->'booking'->>'status'='confirmed','R3 u2 (starts below)');
select del_test.assert_that(del_test.session('01','2',780,900)->>'outcome'='created','session S1');
select del_test.assert_that(del_test.grp('2','01','15','["Ana","Ben"]')->'booking'->>'status'='confirmed','G1 u2');
select del_test.assert_that(del_test.grp('3','01','16','["Cy"]')->'booking'->>'status'='confirmed','G4 u3');
select del_test.assert_that(public.session_walk_in(del_test.u('1'),del_test.group_input('01','17','["Walk Lee"]'))->'booking'->>'status'='confirmed','walk-in');
select del_test.assert_that(del_test.session('03','1',900,960)->>'outcome'='created','session S3');
select del_test.assert_that(del_test.grp('2','03','18','["Eve"]')->'booking'->>'status'='confirmed','G3 u2');
select del_test.assert_that(public.session_booking_change(del_test.u('2'),del_test.gid('18'),'cancel')->'booking'->>'status'='cancelled','G3 cancelled earlier');
select del_test.assert_that(public.venue_report_submit(del_test.u('2'),jsonb_build_object('request_id',del_test.k('19'),'venue_id',del_test.v('1'),
  'reason','wrong_details','details','Gate closes early'))->>'outcome'='created','u2 report');
reset role;
select del_test.policy('approval');
set local role service_role;
select del_test.assert_that(del_test.rent('2','3','20',720,780)->'booking'->>'status'='pending','R2 u2 pending');
select del_test.assert_that(del_test.session('02','3',780,900)->>'outcome'='created','approval session S2');
select del_test.assert_that(del_test.grp('2','02','21','["Di"]')->'booking'->>'status'='pending','G2 u2 pending');
select del_test.assert_that(del_test.grp('7','02','22','["Fay","Gus"]')->'booking'->>'status'='pending','G7 u7 pending');
-- Trusted SQL stands in for time passing: R3 started half an hour ago.
reset role;
update private.court_allocations set starts_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)-interval '30 minutes',
  ends_at=to_timestamp(floor(extract(epoch from now())/1800)*1800)+interval '30 minutes' where id=del_test.rid('14');

set local role service_role;
-- Console accounts and unknown accounts are refused before anything changes.
select del_test.expect_error($q$select public.account_deletion_begin(del_test.u('5'))$q$,'42501','privileged_account');
select del_test.expect_error($q$select public.account_deletion_begin(del_test.u('9'))$q$,'P0002','account_required');
select del_test.expect_error($q$select public.account_deletion_begin(null)$q$,'P0002','account_required');
select del_test.assert_that(not del_test.deleting('5') and public.account_deletion_status(del_test.u('5'))='none','refused account has no deletion record');

-- Player deletion: upcoming rentals and groups are cancelled by the player's own commands; names erased everywhere.
select set_config('del.player',public.account_deletion_begin(del_test.u('2'))::text,true);
select del_test.assert_that(current_setting('del.player')::jsonb='{"outcome":"started","released_venues":0,"retired_drafts":0,
  "cancelled_rentals":2,"cancelled_groups":2,"erased_groups":3}'::jsonb,'player summary '||current_setting('del.player'));
select del_test.assert_that(del_test.rental('10')='cancelled/released' and del_test.rental_events('10')='request:true,cancel:true','R1 cancelled by u2 '||del_test.rental_events('10'));
select del_test.assert_that(del_test.rental('20')='cancelled/released' and del_test.rental_events('20')='request:true,cancel:true','R2 pending cancelled by u2');
select del_test.assert_that(del_test.rental('14')='confirmed/active' and del_test.rental_events('14')='request:true','started R3 untouched');
select del_test.assert_that(del_test.rental('11')='confirmed/active' and del_test.rental('12')='confirmed/active','other player and owner entry untouched');
select del_test.assert_that(del_test.grp_state('15')='cancelled:["Guest 1", "Guest 2"]' and del_test.grp_events('15')='request,cancel','G1 cancelled, names erased');
select del_test.assert_that(del_test.grp_state('21')='cancelled:["Guest 1"]','G2 pending cancelled, names erased');
select del_test.assert_that(del_test.grp_state('18')='cancelled:["Guest 1"]' and del_test.grp_events('18')='request,cancel','earlier G3 erased, no new event');
select del_test.assert_that(del_test.grp_input('15')->'participants'='["Guest 1","Guest 2"]'::jsonb
  and del_test.grp_input('15')->>'request_id'=del_test.k('15')::text,'request input erased, identity kept');
select del_test.assert_that(del_test.grp_state('16')='confirmed:["Cy"]' and del_test.grp_state('17')='confirmed:["Walk Lee"]'
  and del_test.grp_state('22')='pending:["Fay", "Gus"]','other groups and walk-ins keep their names');
select del_test.assert_that(del_test.reserved('01')=2 and del_test.reserved('02')=2 and del_test.reserved('03')=0,'spots released once');
-- A retry finds nothing left to change.
select del_test.assert_that(public.account_deletion_begin(del_test.u('2'))='{"outcome":"existing","released_venues":0,"retired_drafts":0,
  "cancelled_rentals":0,"cancelled_groups":0,"erased_groups":0}'::jsonb,'retry changes nothing');
select del_test.assert_that(del_test.rental_events('10')='request:true,cancel:true' and del_test.grp_events('15')='request,cancel','no duplicate events');
select del_test.assert_that(public.account_deletion_status(del_test.u('2'))='pending','deletion pending while the Auth user exists');

-- Once deletion has started nothing new may name the account, through commands or trusted inserts.
select del_test.expect_error($q$select del_test.rent('2','1','30',780,840)$q$,'42501','account_deleted');
select del_test.expect_error($q$select del_test.grp('2','01','31','["Hal"]')$q$,'42501','account_deleted');
select del_test.expect_error($q$select public.venue_report_submit(del_test.u('2'),jsonb_build_object('request_id',del_test.k('32'),
  'venue_id',del_test.v('2'),'reason','closed','details',null))$q$,'42501','account_deleted');
reset role;
select del_test.expect_error($q$insert into private.venue_owners(user_id,venue_id) values (del_test.u('2'),del_test.v('4'))$q$,'42501','account_deleted');
select del_test.expect_error($q$insert into private.account_roles(user_id,role) values (del_test.u('2'),'moderator')$q$,'42501','account_deleted');
select del_test.expect_error($q$insert into private.venue_claims(venue_id,claimant_user_id,evidence_path,request_id)
  values (del_test.v('4'),del_test.u('2'),'x/claim.jpg',del_test.k('33'))$q$,'42501','account_deleted');
select del_test.expect_error($q$insert into private.venue_submissions(submitter_user_id,request_id,name,address_line,city,province,latitude,longitude,
  court_count,evidence_path,duplicates_acknowledged,venue_id) values (del_test.u('2'),del_test.k('34'),'X','X','Manila','Metro Manila',14.6,121,1,
  'x/sub.jpg',true,del_test.v('4'))$q$,'42501','account_deleted');

-- The guard accepts only an exact name erasure for an account whose deletion has started.
select del_test.expect_error($q$update private.session_bookings set participants=private.erased_names(1),
  request_input=request_input||jsonb_build_object('participants',private.erased_names(1)) where request_id=del_test.k('16')$q$,'55000','immutable_booking');
insert into private.account_deletions(user_id) values (del_test.u('7'));
select del_test.expect_error($q$update private.session_bookings set participants='["X","Y"]',
  request_input=request_input||jsonb_build_object('participants','["X","Y"]'::jsonb) where request_id=del_test.k('22')$q$,'55000','immutable_booking');
select del_test.expect_error($q$update private.session_bookings set participants=private.erased_names(2),
  request_input=request_input||jsonb_build_object('participants',private.erased_names(2)),updated_at=updated_at+interval '1 second'
  where request_id=del_test.k('22')$q$,'55000','immutable_booking');
select del_test.expect_error($q$update private.session_bookings set participants=private.erased_names(2),
  request_input=request_input||jsonb_build_object('participants',private.erased_names(2)),status='cancelled'
  where request_id=del_test.k('22')$q$,'55000','immutable_booking');
select del_test.expect_error($q$update private.session_bookings set participants=private.erased_names(2) where request_id=del_test.k('22')$q$,'55000','immutable_booking');
update private.session_bookings set participants=private.erased_names(2),
  request_input=request_input||jsonb_build_object('participants',private.erased_names(2)) where request_id=del_test.k('22');
select del_test.assert_that(del_test.grp_state('22')='pending:["Guest 1", "Guest 2"]','exact erasure accepted');

-- Owner deletion: venues released with an audit row each (last owner unclaims), the pending draft retired;
-- owner entries, blocks, sessions and walk-in names stay with the venue.
set local role service_role;
select set_config('del.owner',public.account_deletion_begin(del_test.u('1'))::text,true);
select del_test.assert_that(current_setting('del.owner')::jsonb='{"outcome":"started","released_venues":2,"retired_drafts":1,
  "cancelled_rentals":0,"cancelled_groups":0,"erased_groups":0}'::jsonb,'owner summary '||current_setting('del.owner'));
select del_test.assert_that(del_test.status(del_test.v('1'))='approved/unclaimed' and del_test.status(del_test.v('2'))='approved/verified'
  and del_test.status(del_test.v('3'))='suspended/unclaimed' and del_test.status(del_test.v('4'))='approved/unclaimed','listing states');
select del_test.assert_that(del_test.revocations(del_test.v('1'))='owner.revoke:owner_request:true'
  and del_test.revocations(del_test.v('2'))='owner.revoke:owner_request:true','one self revocation audit row per venue');
select del_test.assert_that(del_test.directory_audit(del_test.v('3'))='directory.suspend:'||del_test.u('1'),'draft retirement audited');
select del_test.assert_that(del_test.rental('12')='confirmed/active' and del_test.allocation('13')='block/active'
  and del_test.rental('11')='confirmed/active' and del_test.grp_state('17')='confirmed:["Walk Lee"]' and del_test.grp_state('16')='confirmed:["Cy"]',
  'owner entry, player booking and walk-in names stay');
select del_test.expect_error($q$select del_test.rent('3','1','35',840,900)$q$,'P0002','venue_unavailable');

-- Auth deletion cascades the profile, claims and submissions; bookings, events and audits stay with UUIDs only.
reset role;
delete from auth.users where id in (del_test.u('1'),del_test.u('2'));
select del_test.assert_that(not exists(select 1 from public.profiles where id in (del_test.u('1'),del_test.u('2'))),'profiles gone');
select del_test.assert_that(not exists(select 1 from private.venue_claims where claimant_user_id=del_test.u('1'))
  and not exists(select 1 from private.venue_submissions where submitter_user_id=del_test.u('1'))
  and not exists(select 1 from private.venue_owners where user_id in (del_test.u('1'),del_test.u('2'))),'claims, submissions and owner links gone');
select del_test.assert_that((select reporter_user_id is null and details='Gate closes early' and status='open' from private.venue_reports
  where request_id=del_test.k('19')),'open report stays anonymous for reviewers');
select del_test.assert_that(del_test.rental('10')='cancelled/released' and del_test.rental_events('10')='request:true,cancel:true'
  and exists(select 1 from private.rental_snapshots where allocation_id=del_test.rid('10')),'cancelled booking, events and snapshot kept');
select del_test.assert_that(del_test.grp_state('15')='cancelled:["Guest 1", "Guest 2"]' and del_test.status(del_test.v('3'))='suspended/unclaimed','group and retired draft kept');
select del_test.assert_that((select count(*) from private.moderation_audit_events where actor_user_id=del_test.u('1'))=2,'audit survives the account');
set local role service_role;
select del_test.assert_that(public.account_deletion_status(del_test.u('2'))='deleted' and public.account_deletion_status(del_test.u('1'))='deleted'
  and public.account_deletion_status(del_test.u('7'))='pending' and public.account_deletion_status(del_test.u('3'))='none','deletion status');
select del_test.expect_error($q$select public.account_deletion_begin(del_test.u('2'))$q$,'P0002','account_required');

-- Retention: report free text is cleared 180 days after a decision, in bounded batches; open reports keep it.
reset role;
insert into private.venue_reports(venue_id,reporter_user_id,request_id,reason,details,status,reviewed_at,created_at) values
  (del_test.v('2'),del_test.u('3'),del_test.k('40'),'closed','Old note','dismissed',clock_timestamp()-interval '181 days',clock_timestamp()-interval '200 days'),
  (del_test.v('4'),del_test.u('3'),del_test.k('41'),'closed','Recent note','resolved',clock_timestamp()-interval '179 days',clock_timestamp()-interval '200 days'),
  (del_test.v('2'),del_test.u('3'),del_test.k('42'),'closed','Open note','open',null,clock_timestamp()-interval '400 days'),
  (del_test.v('1'),del_test.u('3'),del_test.k('43'),'unsafe','Older note','resolved',clock_timestamp()-interval '300 days',clock_timestamp()-interval '310 days');
select del_test.expect_error($q$select private.privacy_retention_sweep(0)$q$,'22023','invalid_input');
select del_test.assert_that(private.privacy_retention_sweep(1)='{"report_details":1,"more":true}'::jsonb,'first bounded batch');
select del_test.assert_that(del_test.report_details('43')='<null>' and del_test.report_details('40')='Old note','oldest decision first');
select del_test.assert_that(private.privacy_retention_sweep(500)='{"report_details":1,"more":false}'::jsonb,'second batch');
select del_test.assert_that(private.privacy_retention_sweep(500)='{"report_details":0,"more":false}'::jsonb,'nothing left');
select del_test.assert_that(del_test.report_details('40')='<null>' and del_test.report_details('41')='Recent note'
  and del_test.report_details('42')='Open note' and del_test.report_details('19')='Gate closes early','only decisions older than 180 days lose text');

rollback;
