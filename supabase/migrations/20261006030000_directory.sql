-- Directory only: no ownership authorization, schedules, availability or bookings yet.
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;
do $$
begin
  if (select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'postgis') <> 'extensions' then
    raise exception 'PostGIS must be installed in extensions before applying the directory migration';
  end if;
end;
$$;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant usage on schema public, extensions to anon, authenticated, service_role;

create type public.venue_publication_status as enum ('draft', 'approved', 'suspended');
create type public.venue_claim_status as enum ('unclaimed', 'pending', 'verified');
create type public.court_status as enum ('active', 'inactive');
create type public.court_surface as enum ('hard', 'synthetic', 'other');
create type private.claim_review_status as enum ('pending', 'approved', 'rejected');

-- Every column in these public tables is directory information. Keep private
-- claimant IDs, evidence, owner contacts and moderation notes in private tables.
create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  address_line text not null check (char_length(btrim(address_line)) between 1 and 240),
  city text not null check (char_length(btrim(city)) between 1 and 80),
  province text not null check (char_length(btrim(province)) between 1 and 80),
  country_code text not null default 'PH' check (country_code = 'PH'),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  location extensions.geometry(Point, 4326) generated always as
    (extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)) stored,
  publication_status public.venue_publication_status not null default 'draft',
  claim_status public.venue_claim_status not null default 'unclaimed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index venues_location_gist on public.venues using gist (location);
create index venues_published_city on public.venues (city, id) where publication_status = 'approved';

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  surface public.court_surface,
  is_indoor boolean not null default false,
  is_covered boolean not null default false,
  status public.court_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue_id, name)
);
create index courts_venue_status on public.courts (venue_id, status);

-- Evidence storage references are backend-only. Review/ownership commands and
-- evidence-upload storage policies are separate later tasks.
create table private.venue_claims (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  claimant_user_id uuid not null references auth.users(id) on delete cascade,
  evidence_path text not null check (char_length(btrim(evidence_path)) between 1 and 500),
  status private.claim_review_status not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index venue_claims_venue on private.venue_claims (venue_id);

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;
revoke all on function private.set_updated_at() from public, anon, authenticated;
create trigger venues_updated_at before update on public.venues
  for each row execute function private.set_updated_at();
create trigger courts_updated_at before update on public.courts
  for each row execute function private.set_updated_at();
create trigger venue_claims_updated_at before update on private.venue_claims
  for each row execute function private.set_updated_at();

alter table public.venues enable row level security;
alter table public.courts enable row level security;
alter table private.venue_claims enable row level security;

-- Explicit grants override Supabase project default grants. Authentication by
-- itself never permits publishing, claiming, editing or reading claim evidence.
revoke all on public.venues, public.courts, private.venue_claims from public, anon, authenticated;
grant select on public.venues, public.courts to anon, authenticated;
grant all on public.venues, public.courts, private.venue_claims to service_role;

create policy venues_approved_read on public.venues for select to anon, authenticated
  using (publication_status = 'approved');
create policy courts_public_read on public.courts for select to anon, authenticated
  using (status = 'active' and exists (
    select 1 from public.venues v where v.id = venue_id and v.publication_status = 'approved'
  ));
-- No client policies exist on private.venue_claims; RLS denies all client access
-- even if a future schema/table grant is accidentally added.

-- Bounded spatial primitive for the directory foundation. The complete search
-- API, pagination/filters and server request guard are T13/T14.
create function public.venues_in_bounds(
  south double precision, west double precision,
  north double precision, east double precision
) returns table (
  id uuid, name text, city text, province text,
  latitude double precision, longitude double precision,
  claim_status public.venue_claim_status
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if south is null or west is null or north is null or east is null
     or not (south between -90 and 90 and north between -90 and 90
             and west between -180 and 180 and east between -180 and 180
             and south <= north and west <= east) then
    raise exception 'Invalid map bounds (antimeridian crossing is not supported)' using errcode = '22023';
  end if;
  return query
    select v.id, v.name, v.city, v.province, v.latitude, v.longitude, v.claim_status
    from public.venues v
    where v.publication_status = 'approved'
      and v.location operator(extensions.&&) extensions.st_makeenvelope(west, south, east, north, 4326)
    order by v.id
    limit 200;
end;
$$;
revoke all on function public.venues_in_bounds(double precision, double precision, double precision, double precision)
  from public, anon, authenticated;
grant execute on function public.venues_in_bounds(double precision, double precision, double precision, double precision)
  to anon, authenticated, service_role;
