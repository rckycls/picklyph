-- Personal details and a private profile photo, read and edited only by the account
-- itself. Nothing here is shown to other users, reviewers or owners: T08's self-only
-- profile RLS still applies, and ownership_submitter keeps returning display_name only.

alter table public.profiles
  add column first_name text check (first_name is null or (first_name = btrim(first_name)
    and char_length(first_name) between 1 and 50 and first_name !~ '[[:cntrl:]]')),
  add column last_name text check (last_name is null or (last_name = btrim(last_name)
    and char_length(last_name) between 1 and 50 and last_name !~ '[[:cntrl:]]')),
  -- Philippine mobile numbers in E.164 (+63 9XX XXX XXXX).
  add column phone text check (phone is null or phone ~ '^\+639[0-9]{9}$'),
  -- An object in the private avatars bucket, under the account's own folder.
  add column avatar_path text check (avatar_path is null or avatar_path ~ ('^' || id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'));
grant update (first_name, last_name, phone, avatar_path) on public.profiles to authenticated;

-- Private bucket: only the uploader can upload, read (signed URLs) or delete objects in
-- their own folder. Photos keep whatever metadata the picker leaves, which only the
-- uploader can read. Account deletion (T47) must remove these objects; storage rows do
-- not cascade from auth.users.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 5242880, array['image/jpeg', 'image/png'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy avatars_self_read on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text);
create policy avatars_self_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and name ~ ('^' || (select auth.uid())::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png)$'));
create policy avatars_self_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and split_part(name, '/', 1) = (select auth.uid())::text);
notify pgrst, 'reload schema';
