-- Synthetic rollback-only acceptance. Never use hosted data.
begin;
create schema policies_test;
create function policies_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Policy assertion: %',message; end if; end; $$;
create function policies_test.expect_error(statement text, expected_code text, expected_hint text default null) returns void language plpgsql as $$
declare actual_hint text;
begin
  begin execute statement;
  exception when others then
    get stacked diagnostics actual_hint=pg_exception_hint;
    if sqlstate=expected_code and (expected_hint is null or actual_hint=expected_hint) then return; end if;
    raise exception 'Policy expected %/%, got %/%',expected_code,expected_hint,sqlstate,actual_hint;
  end;
  raise exception 'Policy expected error: %',statement;
end; $$;
grant usage on schema policies_test to anon,authenticated,service_role;
grant execute on all functions in schema policies_test to anon,authenticated,service_role;
insert into auth.users(id) values ('71000000-0000-4000-8000-000000000001'),('71000000-0000-4000-8000-000000000002'),('71000000-0000-4000-8000-000000000003');
insert into private.account_roles(user_id,role) values ('71000000-0000-4000-8000-000000000003','admin');
insert into public.venues(id,name,address_line,city,province,latitude,longitude,publication_status,claim_status) values
('72000000-0000-4000-8000-000000000001','Policies','Fixture','Manila','Metro Manila',14.6,121,'approved','verified'),
('72000000-0000-4000-8000-000000000002','Other','Fixture','Manila','Metro Manila',14.6,121,'approved','verified');
insert into private.venue_owners(user_id,venue_id) values ('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
select policies_test.assert_that((public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001')->>'revision')='0','initial version');
select policies_test.assert_that((public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001') @> '{"confirmation":"instant","payment":"arrival","merchant_active":false}'),'locked defaults');
set local role anon;
select policies_test.expect_error($q$select public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001')$q$,'42501');
reset role;
set local role authenticated;
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"approval","payment":"arrival"}')$q$,'42501');
select policies_test.expect_error($q$insert into private.venue_merchants(venue_id,active) values ('72000000-0000-4000-8000-000000000001',true)$q$,'42501');
reset role;
set local role service_role;
select policies_test.expect_error($q$update private.venue_merchants set active=true$q$,'42501');
select policies_test.expect_error($q$update private.venue_policies set payment='both'$q$,'42501');
select policies_test.expect_error($q$select private.venue_policy_view('72000000-0000-4000-8000-000000000001')$q$,'42501');
select policies_test.expect_error($q$select public.owner_venue_policy_read('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000001')$q$,'42501','not_owner');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000001','0','{"confirmation":"instant","payment":"arrival"}')$q$,'42501','not_owner');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000002','0','{"confirmation":"instant","payment":"arrival"}')$q$,'42501','not_owner');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"instant","payment":"online"}')$q$,'42501','merchant_inactive');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"instant","payment":"both"}')$q$,'42501','merchant_inactive');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"approval","payment":"arrival","merchant_active":true}')$q$,'22023','invalid_input');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":null,"payment":"arrival"}')$q$,'22023','invalid_input');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','[]')$q$,'22023','invalid_input');
select policies_test.assert_that(public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"approval","payment":"arrival"}') @> '{"revision":"1","confirmation":"approval","payment":"arrival"}','save');
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','0','{"confirmation":"instant","payment":"arrival"}')$q$,'40001','version_conflict');
reset role;
select policies_test.assert_that((select count(*)=1 and bool_and(actor_user_id='71000000-0000-4000-8000-000000000001'::uuid) from private.directory_audit_events where action='policy.update'),'one verified actor audit');
-- Only a trusted SQL operator can simulate activation, never the owner/service API.
insert into private.venue_merchants(venue_id,active) values ('72000000-0000-4000-8000-000000000001',true);
select policies_test.assert_that(public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','1','{"confirmation":"instant","payment":"online"}') @> '{"revision":"2","payment":"online","merchant_active":true}','activated online');
select policies_test.assert_that(public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','2','{"confirmation":"approval","payment":"both"}') @> '{"revision":"3","payment":"both"}','activated both');
update private.venue_merchants set active=false;
select policies_test.assert_that(public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001') @> '{"payment":"arrival","merchant_active":false}','activation loss fails closed');
-- An audit error must roll back policy/version along with the mutation.
create function policies_test.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'forced audit failure'; end; $$;
create trigger policies_force_audit before insert on private.directory_audit_events for each row execute function policies_test.fail_audit();
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','3','{"confirmation":"instant","payment":"arrival"}')$q$,'P0001');
drop trigger policies_force_audit on private.directory_audit_events;
select policies_test.assert_that((select revision=3 and payment='both' from private.venue_policies),'audit rollback');
update public.venues set publication_status='suspended' where id='72000000-0000-4000-8000-000000000001';
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','3','{"confirmation":"instant","payment":"arrival"}')$q$,'P0002','venue_unavailable');
update public.venues set publication_status='draft' where id='72000000-0000-4000-8000-000000000001';
select policies_test.expect_error($q$select public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001')$q$,'P0002','venue_unavailable');
update public.venues set publication_status='approved',claim_status='unclaimed' where id='72000000-0000-4000-8000-000000000001';
select policies_test.expect_error($q$select public.owner_venue_policy_save('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001','3','{"confirmation":"instant","payment":"arrival"}')$q$,'P0002','venue_unavailable');
delete from private.venue_owners;
select policies_test.expect_error($q$select public.owner_venue_policy_read('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001')$q$,'42501','not_owner');
rollback;
