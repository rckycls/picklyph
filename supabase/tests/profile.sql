-- Synthetic, rollback-only personal details and profile photo acceptance. Never run on hosted data.
begin;
create schema profile_test;
create function profile_test.assert_that(result boolean, message text) returns void language plpgsql as $$
begin if result is distinct from true then raise exception 'Profile assertion failed: %', message; end if; end;
$$;
create function profile_test.expect_error(statement text, expected_code text) returns void language plpgsql as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise exception 'Expected %, got % (%): %', expected_code, sqlstate, sqlerrm, statement;
  end;
  raise exception 'Expected % but statement succeeded: %', expected_code, statement;
end;
$$;
grant usage on schema profile_test to anon, authenticated, service_role;
grant execute on all functions in schema profile_test to anon, authenticated, service_role;

insert into auth.users(id) values ('61000000-0000-4000-8000-000000000001'), ('61000000-0000-4000-8000-000000000002');
select profile_test.assert_that((select not public and file_size_limit = 5242880 and allowed_mime_types = array['image/jpeg','image/png']
  from storage.buckets where id = 'avatars'), 'private, bounded avatars bucket');

select set_config('request.jwt.claims', '{"sub":"61000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
update public.profiles set first_name = 'Rocky', last_name = 'Celis', phone = '+639171234567',
  avatar_path = '61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg'
  where id = '61000000-0000-4000-8000-000000000001';
select profile_test.assert_that((select first_name = 'Rocky' and last_name = 'Celis' and phone = '+639171234567'
  and avatar_path like '61000000-0000-4000-8000-000000000001/%' from public.profiles), 'own personal details save');
select profile_test.expect_error(format($q$update public.profiles set %s where id = '61000000-0000-4000-8000-000000000001'$q$, change), '23514')
from unnest(array[
  $c$first_name = ' Rocky'$c$, $c$first_name = ''$c$, $c$last_name = repeat('x', 51)$c$, $c$last_name = E'Ce\u0007lis'$c$,
  $c$phone = '09171234567'$c$, $c$phone = '+63917123456'$c$, $c$phone = '+638171234567'$c$,
  $c$avatar_path = '61000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000001.jpg'$c$,
  $c$avatar_path = '61000000-0000-4000-8000-000000000001/../x.jpg'$c$,
  $c$avatar_path = '61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.gif'$c$
]) change;
select profile_test.expect_error($q$update public.profiles set created_at = now() where id = '61000000-0000-4000-8000-000000000001'$q$, '42501');
update public.profiles set first_name = 'Mallory' where id = '61000000-0000-4000-8000-000000000002';
select profile_test.assert_that((select count(*) = 1 from public.profiles), 'others'' details stay private');
-- Photos: own folder only, server-shaped names, image types enforced by the bucket.
insert into storage.objects(bucket_id, name) values
  ('avatars', '61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg');
select profile_test.expect_error($q$insert into storage.objects(bucket_id, name) values ('avatars', '61000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000002.jpg')$q$, '42501');
select profile_test.expect_error($q$insert into storage.objects(bucket_id, name) values ('avatars', '61000000-0000-4000-8000-000000000001/avatar.jpg')$q$, '42501');
select profile_test.expect_error($q$insert into storage.objects(bucket_id, name) values ('owner-evidence', '61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000003.jpg')$q$, '42501');
reset role;
insert into storage.objects(bucket_id, name) values
  ('avatars', '61000000-0000-4000-8000-000000000002/62000000-0000-4000-8000-000000000004.png');
set local role authenticated;
select profile_test.assert_that((select count(*) = 1 from storage.objects where bucket_id = 'avatars'), 'only own photos are visible');
-- The Storage API sets this before its deletes; RLS still decides which rows go.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'avatars' and name like '61000000-0000-4000-8000-000000000002/%';
delete from storage.objects where name = '61000000-0000-4000-8000-000000000001/62000000-0000-4000-8000-000000000001.jpg';
reset role;
select profile_test.assert_that((select count(*) = 1 from storage.objects where bucket_id = 'avatars'
  and name like '61000000-0000-4000-8000-000000000002/%'), 'users delete only their own photos');
select profile_test.assert_that((select first_name is null from public.profiles where id = '61000000-0000-4000-8000-000000000002'),
  'another user''s details are never changed');

set local role anon;
select profile_test.expect_error($q$select * from public.profiles$q$, '42501');
select profile_test.assert_that((select count(*) = 0 from storage.objects where bucket_id = 'avatars'), 'guests see no photos');
reset role;
rollback;
