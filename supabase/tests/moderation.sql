-- Rollback-only T46 fixtures: reports, moderation decisions, suspension vs every booking
-- command, reinstatement limits, audited revocation and the moderator denial matrix.
begin;
create schema mod_test;
create function mod_test.assert_that(ok boolean,message text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Moderation assertion failed: %',message; end if; end; $$;
create function mod_test.expect_error(statement text,code text,hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=code and (hint is null or actual_hint=hint) then return; end if;
    raise exception 'Expected %/%, got %/%: %',code,hint,sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected failure: %',statement;
end; $$;
-- A suspended or unclaimed listing refuses through the venue check or, for owner commands, the owner check.
create function mod_test.expect_refused(statement text) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then get stacked diagnostics actual_hint=pg_exception_hint;
    if actual_hint in ('venue_unavailable','not_owner') then return; end if;
    raise exception 'Expected a listing refusal, got %/%: %',sqlstate,actual_hint,sqlerrm;
  end;
  raise exception 'Expected refusal: %',statement;
end; $$;
create function mod_test.at(minute integer) returns timestamptz language sql stable as $$
select (((now() at time zone 'Asia/Manila')::date+2)::timestamp + minute*interval '1 minute') at time zone 'Asia/Manila'; $$;
create function mod_test.u(n text) returns uuid language sql immutable as $$ select ('c4610000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function mod_test.v(n text) returns uuid language sql immutable as $$ select ('c4620000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function mod_test.c(n text) returns uuid language sql immutable as $$ select ('c4630000-0000-4000-8000-00000000000'||n)::uuid; $$;
create function mod_test.k(n text) returns uuid language sql immutable as $$ select ('c4650000-0000-4000-8000-0000000000'||n)::uuid; $$;
create function mod_test.bulk(n integer) returns uuid language sql immutable as $$ select ('c4660000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function mod_test.quote(actor text,court text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_quote(mod_test.u(actor),mod_test.c(court),mod_test.at(a),mod_test.at(b))->'expected_quote'; $$;
create function mod_test.rent(actor text,court text,request text,a integer,b integer) returns jsonb language sql as $$
select public.rental_booking_request(mod_test.u(actor),mod_test.c(court),mod_test.k(request),mod_test.at(a),mod_test.at(b),mod_test.quote(actor,court,a,b)); $$;
create function mod_test.session(request text,court text,a integer,b integer) returns jsonb language sql as $$
select public.owner_session_create(mod_test.u('1'),jsonb_build_object('venue_id',mod_test.v('1'),'request_id',mod_test.k(request),
  'court_ids',jsonb_build_array(mod_test.c(court)),'title','Moderation play','starts_at',mod_test.at(a),'ends_at',mod_test.at(b),
  'capacity',8,'group_limit',4,'price_centavos',25000)); $$;
create function mod_test.sid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.open_play_sessions where request_id=mod_test.k(request); $$;
create function mod_test.group_input(session text,request text,names jsonb) returns jsonb language sql as $$
select jsonb_build_object('session_id',mod_test.sid(session),'request_id',mod_test.k(request),'participants',names,
  'expected_total_centavos',25000*jsonb_array_length(names)); $$;
create function mod_test.rid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.court_allocations where request_id=mod_test.k(request); $$;
create function mod_test.gid(request text) returns uuid language sql security definer set search_path='' as $$
select id from private.session_bookings where request_id=mod_test.k(request); $$;
create function mod_test.report(actor text,request text,venue uuid,reason text,details text default null) returns jsonb language sql as $$
select public.venue_report_submit(mod_test.u(actor),jsonb_build_object('request_id',mod_test.k(request),'venue_id',venue,'reason',reason,'details',details)); $$;
create function mod_test.report_id(actor text,request text) returns uuid language sql security definer set search_path='' as $$
select id from private.venue_reports where reporter_user_id=mod_test.u(actor) and request_id=mod_test.k(request); $$;
create function mod_test.status(venue uuid) returns text language sql security definer set search_path='' as $$
select publication_status::text||'/'||claim_status::text from public.venues where id=venue; $$;
create function mod_test.audit(venue uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(action||coalesce(':'||reason,''),',' order by id),'') from private.moderation_audit_events where target_venue_id=venue; $$;
create function mod_test.directory_audit(venue uuid) returns text language sql security definer set search_path='' as $$
select coalesce(string_agg(action,',' order by id),'') from private.directory_audit_events where target_venue_id=venue
  and action in ('directory.suspend','directory.publish'); $$;
create function mod_test.marked(venue uuid) returns boolean language sql security definer set search_path='' as $$
select exists(select 1 from private.venue_moderation_suspensions where venue_id=venue); $$;
-- Trusted SQL only: stand in for operator policy.
create function mod_test.policy(text) returns void language sql security definer as $$
insert into private.venue_policies(venue_id,confirmation,payment) values(mod_test.v('1'),$1,'arrival')
  on conflict (venue_id) do update set confirmation=excluded.confirmation,revision=private.venue_policies.revision+1; $$;
grant usage on schema mod_test to anon,authenticated,service_role;
grant execute on all functions in schema mod_test to anon,authenticated,service_role;

-- u1 owns V1, u6 is a moderator who owns V2, u4 moderator, u5 admin, u2/u3/u7/u8 players.
insert into auth.users(id) select mod_test.u(n::text) from generate_series(1,8) n;
insert into private.account_roles(user_id,role) values (mod_test.u('4'),'moderator'),(mod_test.u('5'),'admin'),(mod_test.u('6'),'moderator');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
  (mod_test.v('1'),'Moderation Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  (mod_test.v('2'),'Moderator Owned Fixture','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
  (mod_test.v('3'),'Admin Suspended Fixture','Fixture','Manila','Metro Manila',14.6,121,'suspended','verified'),
  (mod_test.v('4'),'Draft Fixture','Fixture','Manila','Metro Manila',14.6,121,'draft','unclaimed');
insert into public.courts(id,venue_id,name,status) select mod_test.c(n::text),mod_test.v('1'),chr(64+n),'active' from generate_series(1,3) n;
insert into public.courts(id,venue_id,name,status) values (mod_test.c('4'),mod_test.v('2'),'A','active'),(mod_test.c('5'),mod_test.v('3'),'A','active');
insert into private.venue_owners(user_id,venue_id) values (mod_test.u('1'),mod_test.v('1')),(mod_test.u('6'),mod_test.v('2'));
select public.venue_schedule_save(mod_test.u('1'),mod_test.v('1'),null,
  jsonb_build_object('weekly',(select jsonb_agg(jsonb_build_array(jsonb_build_object('start_minute',0,'end_minute',1440,'rates',jsonb_build_array(
    jsonb_build_object('start_minute',0,'end_minute',1440,'hourly_centavos',40000))))) from generate_series(1,7)),'exceptions','[]'::jsonb));

set local role service_role;
-- Before any moderation every booking command works (instant arrival policy).
select mod_test.assert_that(mod_test.rent('7','1','10',600,660)->'booking'->>'status'='confirmed','player rental R0');
select mod_test.assert_that(public.rental_booking_owner_entry(mod_test.u('1'),mod_test.c('1'),mod_test.k('11'),mod_test.at(660),mod_test.at(720),
  'Walk-up guest',mod_test.quote('1','1',660,720))->'booking'->>'status'='confirmed','owner entry');
select mod_test.assert_that(public.court_allocation_block(mod_test.u('1'),mod_test.c('1'),mod_test.k('12'),mod_test.at(720),mod_test.at(780))->>'outcome'='created','block');
select mod_test.assert_that(mod_test.session('01','2',600,720)->>'outcome'='created','session S1');
select mod_test.assert_that(public.session_booking_request(mod_test.u('7'),mod_test.group_input('01','13','["Ana","Ben"]'))->'booking'->>'status'='confirmed','group G0');
select mod_test.assert_that(public.session_walk_in(mod_test.u('1'),mod_test.group_input('01','14','["Cy"]'))->'booking'->>'status'='confirmed','walk-in');
reset role;
select mod_test.policy('approval');
set local role service_role;
select mod_test.assert_that(mod_test.rent('3','3','15',600,660)->'booking'->>'status'='pending','pending rental');
-- Sessions snapshot their policy, so the approval session is created after the switch.
select mod_test.assert_that(mod_test.session('02','2',780,900)->>'outcome'='created','approval session S2');
select mod_test.assert_that(public.session_booking_request(mod_test.u('3'),mod_test.group_input('02','16','["Di"]'))->'booking'->>'status'='pending','pending group');
select set_config('mod.rent_quote',mod_test.quote('7','3',720,780)::text,true), set_config('mod.entry_quote',mod_test.quote('1','3',780,840)::text,true);

-- Reports: strict input, retry identity, one open report per reporter and listing.
select mod_test.assert_that(mod_test.report('2','20',mod_test.v('1'),'wrong_details','Hours are wrong'||chr(10)||'since June')->>'outcome'='created','report created');
select mod_test.assert_that(mod_test.report('2','20',mod_test.v('1'),'wrong_details','Hours are wrong'||chr(10)||'since June')->>'outcome'='existing','report retry');
select mod_test.assert_that(mod_test.report('2','20',mod_test.v('1'),'wrong_details','Hours are wrong'||chr(10)||'since June')->'report'->>'id'
  =mod_test.report_id('2','20')::text,'retry returns the original report');
select mod_test.expect_error($q$select mod_test.report('2','20',mod_test.v('1'),'closed')$q$,'23505','request_reused');
select mod_test.expect_error($q$select mod_test.report('2','21',mod_test.v('1'),'closed')$q$,'23505','already_reported');
select mod_test.assert_that(mod_test.report('3','22',mod_test.v('1'),'closed')->'report'->>'details' is null,'second reporter without details');
select mod_test.assert_that(mod_test.report('3','23',mod_test.v('2'),'unsafe','Broken fence')->>'outcome'='created','report on V2');
select mod_test.expect_error($q$select mod_test.report('2','24',mod_test.v('4'),'closed')$q$,'P0002','venue_unavailable');
select mod_test.expect_error($q$select mod_test.report('2','24',mod_test.v('3'),'closed')$q$,'P0002','venue_unavailable');
select mod_test.expect_error($q$select mod_test.report('2','24',mod_test.v('9'),'closed')$q$,'P0002','venue_unavailable');
select mod_test.expect_error($q$select mod_test.report('9','24',mod_test.v('1'),'closed')$q$,'42501','account_required');
select mod_test.expect_error(format('select public.venue_report_submit(%L,%L)',mod_test.u('8'),input),'22023','invalid_input') from (values
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','rude','details',null)),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed')),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details',null,'actor_user_id',mod_test.u('4'))),
  (jsonb_build_object('request_id','nope','venue_id',mod_test.v('1'),'reason','closed','details',null)),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',1,'reason','closed','details',null)),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details','')),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details',' padded')),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details',repeat('x',501))),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details','tab'||chr(9)||'bed')),
  (jsonb_build_object('request_id',mod_test.k('25'),'venue_id',mod_test.v('1'),'reason','closed','details',3)),
  ('[]'::jsonb)) t(input);
select mod_test.assert_that(mod_test.report('8','26',mod_test.v('1'),'other',repeat('é',500))->>'outcome'='created','500 code points of details');
reset role;
-- 20 open reports cap per reporter, plus anonymous reports on 59 more listings for paging.
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status)
  select mod_test.bulk(n),'Bulk '||n,'Fixture','Cebu','Cebu',10.3,123.9,'approved','unclaimed' from generate_series(1,60) n;
insert into private.venue_reports(venue_id,reporter_user_id,request_id,reason,created_at)
  select mod_test.bulk(n),case when n<=19 then mod_test.u('8') end,gen_random_uuid(),'duplicate',now()-interval '1 day'+n*interval '1 second'
  from generate_series(1,59) n;
set local role service_role;
select mod_test.expect_error($q$select mod_test.report('8','27',mod_test.bulk(60),'closed')$q$,'54000','too_many_reports');
select mod_test.assert_that(mod_test.report('2','27',mod_test.bulk(60),'closed')->>'outcome'='created','other reporters unaffected');
select mod_test.assert_that(mod_test.audit(mod_test.v('1'))='report.submit,report.submit,report.submit','one audit row per created report');

-- Queue and read: admins/moderators only, current roles, bounded keyset pages.
select mod_test.expect_error($q$select public.moderation_queue(mod_test.u('2'))$q$,'42501','moderator_required');
select mod_test.expect_error($q$select public.moderation_queue(mod_test.u('1'))$q$,'42501','moderator_required');
select mod_test.expect_error($q$select public.moderation_venue_read(mod_test.u('1'),mod_test.v('1'))$q$,'42501','moderator_required');
select mod_test.expect_error($q$select public.moderation_queue(mod_test.u('4'),now(),null)$q$,'22023','invalid_input');
select mod_test.assert_that((select (q->>'open_total')::integer=62 and jsonb_array_length(q->'items')=50 and q->'next_cursor' is not null
  and q->'items'->0->>'venue_id'=mod_test.bulk(1)::text from public.moderation_queue(mod_test.u('4')) q),'first page oldest first');
select mod_test.assert_that((select jsonb_array_length(p2->'items')=12 and p2->'next_cursor'='null'::jsonb
  and not exists(select 1 from jsonb_array_elements(p1->'items') a join jsonb_array_elements(p2->'items') b on a->>'venue_id'=b->>'venue_id')
  from (select q as p1,public.moderation_queue(mod_test.u('5'),(q->'next_cursor'->>'created_at')::timestamptz,(q->'next_cursor'->>'id')::uuid) as p2
    from public.moderation_queue(mod_test.u('5')) q) x),'second page completes the queue without overlap');
select mod_test.assert_that((select i->>'open_reports'='3' and i->'reasons'='["closed","other","wrong_details"]'::jsonb and i->>'publication_status'='approved'
  from jsonb_array_elements((public.moderation_queue(mod_test.u('5'),(public.moderation_queue(mod_test.u('5'))->'next_cursor'->>'created_at')::timestamptz,
    (public.moderation_queue(mod_test.u('5'))->'next_cursor'->>'id')::uuid))->'items') i where i->>'venue_id'=mod_test.v('1')::text),'V1 queue row');
select mod_test.assert_that((select r->'suspension'='null'::jsonb and (r->>'open_reports')::integer=3 and jsonb_array_length(r->'reports')=3
  and r->'owners'->0->>'user_id'=mod_test.u('1')::text and r->'reports'->0->'reporter'->>'id' is not null
  and jsonb_array_length(r->'history')=3 and (r->'venue'->>'active_court_count')::integer=3
  from public.moderation_venue_read(mod_test.u('4'),mod_test.v('1')) r),'reviewer snapshot');
select mod_test.expect_error($q$select public.moderation_venue_read(mod_test.u('4'),mod_test.v('9'))$q$,'P0002','not_found');

-- Decisions: strict input, no self-moderation, decided once.
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('2'),mod_test.v('1'),'dismiss',null,array[mod_test.report_id('3','22')])$q$,'42501','moderator_required');
select mod_test.expect_error(format('select public.moderation_decide(%L,%L,%L,%L,%L::uuid[])',mod_test.u('4'),mod_test.v('1'),d,r,ids),'22023','invalid_input') from (values
  ('ban',null,array[mod_test.report_id('3','22')]),('suspend',null,'{}'::uuid[]),('dismiss','closed',array[mod_test.report_id('3','22')]),
  ('dismiss',null,'{}'::uuid[]),('reinstate',null,array[mod_test.report_id('3','22')]),('suspend','rude','{}'::uuid[]),
  ('dismiss',null,array[mod_test.report_id('3','22'),mod_test.report_id('3','22')]),('dismiss',null,array[mod_test.report_id('3','23')]),
  ('dismiss',null,array[null::uuid]),('dismiss',null,(select array_agg(gen_random_uuid()) from generate_series(1,101)))) t(d,r,ids);
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('6'),mod_test.v('2'),'dismiss',null,array[mod_test.report_id('3','23')])$q$,'42501','self_moderation');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('6'),mod_test.v('2'),'suspend','unsafe','{}')$q$,'42501','self_moderation');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('9'),'reinstate',null,'{}')$q$,'P0002','not_found');
select mod_test.assert_that(public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'dismiss',null,array[mod_test.report_id('3','22')])->>'outcome'='decided','dismiss');
select mod_test.assert_that(public.moderation_decide(mod_test.u('5'),mod_test.v('1'),'dismiss',null,array[mod_test.report_id('3','22')])->>'outcome'='existing','dismiss retry');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'resolve',null,array[mod_test.report_id('3','22')])$q$,'23505','already_decided');
-- A dismissed report frees its reporter to report the listing again.
select mod_test.assert_that(mod_test.report('3','28',mod_test.v('1'),'unsafe')->>'outcome'='created','new report after dismissal');

-- An audit failure aborts the whole suspension.
reset role;
alter table private.moderation_audit_events add constraint mod_test_audit_down check (action <> 'venue.suspend') not valid;
set local role service_role;
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'suspend','unsafe',array[mod_test.report_id('2','20')])$q$,'23514');
select mod_test.assert_that(mod_test.status(mod_test.v('1'))='approved/verified' and not mod_test.marked(mod_test.v('1'))
  and (select r->'reports'->0->>'status'='open' from public.moderation_venue_read(mod_test.u('4'),mod_test.v('1')) r),'rolled back with its audit');
reset role;
alter table private.moderation_audit_events drop constraint mod_test_audit_down;
set local role service_role;

-- Suspension: one audited transaction; every new booking path stops at once.
select mod_test.assert_that((select d->>'outcome'='decided' and d->'item'->'suspension'->>'reason'='unsafe'
  and d->'item'->'venue'->>'publication_status'='suspended'
  from public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'suspend','unsafe',array[mod_test.report_id('2','20'),mod_test.report_id('8','26')]) d),'suspend');
select mod_test.assert_that(mod_test.status(mod_test.v('1'))='suspended/verified' and mod_test.marked(mod_test.v('1')),'suspended with marker');
select mod_test.assert_that(mod_test.audit(mod_test.v('1'))='report.submit,report.submit,report.submit,report.dismiss,report.submit,venue.suspend:unsafe,report.resolve,report.resolve',
  'moderation history');
select mod_test.assert_that(mod_test.directory_audit(mod_test.v('1'))='directory.suspend','directory history');
select mod_test.assert_that(public.moderation_decide(mod_test.u('5'),mod_test.v('1'),'suspend','closed','{}')->>'outcome'='existing','suspend retry');
select mod_test.assert_that(mod_test.audit(mod_test.v('1')) not like '%closed%','retry records nothing');
select mod_test.expect_refused($q$select mod_test.quote('7','3',720,780)$q$);
select mod_test.expect_refused($q$select public.rental_booking_request(mod_test.u('7'),mod_test.c('3'),mod_test.k('30'),mod_test.at(720),mod_test.at(780),current_setting('mod.rent_quote')::jsonb)$q$);
select mod_test.expect_refused($q$select public.rental_booking_owner_entry(mod_test.u('1'),mod_test.c('3'),mod_test.k('31'),mod_test.at(780),mod_test.at(840),'Guest',current_setting('mod.entry_quote')::jsonb)$q$);
select mod_test.expect_refused($q$select public.court_allocation_block(mod_test.u('1'),mod_test.c('3'),mod_test.k('32'),mod_test.at(840),mod_test.at(900))$q$);
select mod_test.expect_refused($q$select mod_test.session('33','3',900,960)$q$);
select mod_test.expect_refused($q$select public.session_booking_request(mod_test.u('2'),mod_test.group_input('02','34','["Eve"]'))$q$);
select mod_test.expect_refused($q$select public.session_walk_in(mod_test.u('1'),mod_test.group_input('01','35','["Fay"]'))$q$);
select mod_test.expect_refused($q$select public.rental_booking_change(mod_test.u('1'),mod_test.rid('15'),'accept')$q$);
select mod_test.expect_refused($q$select public.session_booking_change(mod_test.u('1'),mod_test.gid('16'),'accept')$q$);
-- Existing bookings stay; reads, declines and cancellations continue.
select mod_test.assert_that(public.rental_booking_read(mod_test.u('7'),mod_test.rid('10'))->'booking'->>'status'='confirmed','player reads booking');
select mod_test.assert_that(public.rental_booking_change(mod_test.u('7'),mod_test.rid('10'),'cancel')->'booking'->>'status'='cancelled','player cancels');
select mod_test.assert_that(public.session_booking_change(mod_test.u('1'),mod_test.gid('16'),'decline')->'booking'->>'status'='declined','owner declines');
select mod_test.assert_that(public.session_booking_change(mod_test.u('7'),mod_test.gid('13'),'cancel')->'booking'->>'status'='cancelled','group cancels');
reset role;
set local role anon;
select mod_test.assert_that(not exists(select 1 from public.venues where id=mod_test.v('1')),'suspended listing leaves Discover');
reset role;
set local role service_role;
select mod_test.expect_error($q$select mod_test.report('3','36',mod_test.v('1'),'closed')$q$,'P0002','venue_unavailable');

-- Reinstatement undoes only a moderation suspension, and needs an active court.
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('3'),'reinstate',null,'{}')$q$,'55000','not_moderation_suspension');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('4'),'reinstate',null,'{}')$q$,'55000','not_moderation_suspension');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('3'),'suspend','unsafe','{}')$q$,'55000','not_published');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('4'),'suspend','unsafe','{}')$q$,'55000','not_published');
select mod_test.assert_that(mod_test.status(mod_test.v('3'))='suspended/verified' and mod_test.status(mod_test.v('4'))='draft/unclaimed','retired/admin listings unchanged');
select mod_test.assert_that(public.moderation_decide(mod_test.u('4'),mod_test.v('2'),'suspend','inappropriate',array[mod_test.report_id('3','23')])->>'outcome'='decided','suspend V2');
reset role;
update public.courts set status='inactive' where id=mod_test.c('4');
set local role service_role;
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('2'),'reinstate',null,'{}')$q$,'22023','active_court_required');
reset role;
update public.courts set status='active' where id=mod_test.c('4');
set local role service_role;
select mod_test.assert_that(public.moderation_decide(mod_test.u('5'),mod_test.v('1'),'reinstate',null,'{}')->>'outcome'='decided','admin reinstates');
select mod_test.assert_that(mod_test.status(mod_test.v('1'))='approved/verified' and not mod_test.marked(mod_test.v('1')),'published again, marker gone');
select mod_test.assert_that(public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'reinstate',null,'{}')->>'outcome'='existing','reinstate retry');
select mod_test.assert_that(mod_test.audit(mod_test.v('1')) like '%,venue.reinstate' and mod_test.directory_audit(mod_test.v('1'))='directory.suspend,directory.publish','reinstatement audited once');
select mod_test.assert_that(public.rental_booking_change(mod_test.u('1'),mod_test.rid('15'),'accept')->'booking'->>'status'='confirmed','held request accepted after reinstatement');
select mod_test.assert_that(mod_test.rent('7','3','37',720,780)->'booking'->>'status'='pending','new requests resume');
-- Any other path out of suspension ends the moderation marker; an admin suspension is never moderation's to undo.
select public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'suspend','closed','{}');
select public.directory_admin_publish(mod_test.u('5'),mod_test.v('1'),(select updated_at from public.venues where id=mod_test.v('1')),'approved');
select mod_test.assert_that(not mod_test.marked(mod_test.v('1')),'directory publication clears the marker');
select public.directory_admin_publish(mod_test.u('5'),mod_test.v('1'),(select updated_at from public.venues where id=mod_test.v('1')),'suspended');
select mod_test.expect_error($q$select public.moderation_decide(mod_test.u('4'),mod_test.v('1'),'reinstate',null,'{}')$q$,'55000','not_moderation_suspension');
select public.directory_admin_publish(mod_test.u('5'),mod_test.v('1'),(select updated_at from public.venues where id=mod_test.v('1')),'approved');

-- Revocation: audited, no self-moderation, the last owner unclaims the listing.
reset role;
insert into private.venue_owners(user_id,venue_id) values (mod_test.u('8'),mod_test.v('1'));
set local role service_role;
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('2'),mod_test.v('1'),mod_test.u('8'),'not_owner')$q$,'42501','moderator_required');
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('1'),mod_test.v('1'),mod_test.u('8'),'not_owner')$q$,'42501','moderator_required');
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('4'),mod_test.v('1'),mod_test.u('8'),'rude')$q$,'22023','invalid_input');
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('4'),mod_test.v('1'),null,'other')$q$,'22023','invalid_input');
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('6'),mod_test.v('2'),mod_test.u('6'),'other')$q$,'42501','self_moderation');
select mod_test.expect_error($q$select public.ownership_revoke(mod_test.u('4'),mod_test.v('9'),mod_test.u('8'),'other')$q$,'P0002','not_found');
select mod_test.assert_that(public.ownership_revoke(mod_test.u('4'),mod_test.v('1'),mod_test.u('8'),'not_owner')->>'outcome'='decided','revoke co-owner');
select mod_test.assert_that(public.ownership_revoke(mod_test.u('4'),mod_test.v('1'),mod_test.u('8'),'not_owner')->>'outcome'='existing','revoke retry');
select mod_test.assert_that(mod_test.status(mod_test.v('1'))='approved/verified','one owner remains');
select mod_test.assert_that(public.ownership_revoke(mod_test.u('5'),mod_test.v('1'),mod_test.u('1'),'ownership_ended')->'item'->'owners'='[]'::jsonb,'revoke last owner');
select mod_test.assert_that(mod_test.status(mod_test.v('1'))='approved/unclaimed','last owner unclaims the listing');
select mod_test.assert_that(mod_test.audit(mod_test.v('1')) like '%,owner.revoke:not_owner,owner.revoke:ownership_ended','one audit row per revocation');
select mod_test.expect_refused($q$select mod_test.session('38','3',1080,1140)$q$);
select mod_test.expect_refused($q$select public.session_walk_in(mod_test.u('1'),mod_test.group_input('01','39','["Gus"]'))$q$);
select mod_test.expect_refused($q$select mod_test.rent('2','3','40',1080,1140)$q$);
select mod_test.expect_error($q$select public.authorize_venue_management(mod_test.u('1'),mod_test.v('1'))$q$,'42501');
reset role;
select set_config('request.jwt.claims',json_build_object('sub',mod_test.u('1'),'role','authenticated')::text,true);
set local role authenticated;
select mod_test.assert_that((select owned_venue_ids='{}' from public.my_account_access()),'revoked owner loses the venue at once');

-- Moderators gain no path to roles, owner links, curation, payment settings or bookings.
reset role;
select set_config('request.jwt.claims',json_build_object('sub',mod_test.u('4'),'role','authenticated')::text,true);
set local role authenticated;
select mod_test.expect_error($q$select * from private.venue_reports$q$,'42501');
select mod_test.expect_error($q$select public.moderation_queue(mod_test.u('4'))$q$,'42501');
select mod_test.expect_error($q$select public.venue_report_submit(mod_test.u('4'),'{}')$q$,'42501');
reset role;
insert into private.venue_owners(user_id,venue_id) values (mod_test.u('1'),mod_test.v('1'));
update public.venues set claim_status='verified' where id=mod_test.v('1');
set local role service_role;
select mod_test.expect_error($q$select public.set_verified_venue_owner(mod_test.u('4'),mod_test.v('1'),mod_test.u('4'),true)$q$,'42883');
select mod_test.expect_error($q$select public.set_account_role(mod_test.u('4'),mod_test.u('2'),'moderator',true)$q$,'42501');
select mod_test.expect_error($q$select public.directory_admin_publish(mod_test.u('4'),mod_test.v('1'),(select updated_at from public.venues where id=mod_test.v('1')),'suspended')$q$,'42501');
select mod_test.expect_error($q$select public.directory_admin_import(mod_test.u('4'),'[]')$q$,'42501');
select mod_test.expect_error($q$select public.owner_venue_policy_save(mod_test.u('4'),mod_test.v('1'),'0','{"confirmation":"instant","payment":"both"}')$q$,'42501');
select mod_test.expect_error($q$select public.court_allocation_block(mod_test.u('4'),mod_test.c('3'),mod_test.k('41'),mod_test.at(1200),mod_test.at(1260))$q$,'42501');
select mod_test.expect_error($q$select public.rental_booking_change(mod_test.u('4'),mod_test.rid('15'),'cancel')$q$,'42501');
select mod_test.expect_error($q$select public.booking_operation(mod_test.u('4'),'rental',mod_test.rid('15'),'record_payment','cash',40000)$q$,'42501');
select mod_test.expect_error($q$select public.session_walk_in(mod_test.u('4'),mod_test.group_input('01','42','["Hal"]'))$q$,'42501');
reset role;
select mod_test.assert_that((select count(*)=0 from private.venue_owners where user_id=mod_test.u('4'))
  and (select count(*)=2 from private.account_roles where role='moderator'),'no moderator gained an owner link or role');
rollback;
