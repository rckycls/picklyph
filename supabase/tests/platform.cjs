// Minimal Supabase Storage prerequisites for disposable PGlite databases only.
// Supabase grants client roles table access and relies on RLS; with no
// policies, as here, every client row is denied. Docker suites use the real schema.
module.exports.storageStub = `
  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;
  create table storage.buckets(id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets(id), name text not null, owner uuid, metadata jsonb, unique (bucket_id, name));
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;
  grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
`;
