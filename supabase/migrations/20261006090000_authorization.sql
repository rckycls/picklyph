-- T08: identity/authorization only. Venue review, inventory and booking commands
-- remain later tasks; none of these grants permits direct directory mutations.
create type public.privileged_role as enum ('admin', 'moderator');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or
    (display_name = btrim(display_name) and char_length(display_name) between 1 and 80)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant all on public.profiles to service_role;
create policy profiles_self_read on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy profiles_self_update on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

-- Ignore untrusted metadata entirely. Even malformed name/role metadata cannot
-- break signup or manufacture privileges. Display names are a separate edit.
create function private.create_user_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values (new.id);
  return new;
end;
$$;
revoke all on function private.create_user_profile() from public, anon, authenticated, service_role;
create trigger pickly_create_user_profile after insert on auth.users
  for each row execute function private.create_user_profile();
insert into public.profiles(id) select id from auth.users on conflict (id) do nothing;

-- A player is the base signed-in identity. Owner access is venue-specific, not
-- a global role. Neither table is exposed through PostgREST.
create table private.account_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.privileged_role not null,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);
create table private.venue_owners (
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz not null default now(),
  primary key (venue_id, user_id)
);
create index venue_owners_user on private.venue_owners(user_id, venue_id);
alter table private.account_roles enable row level security;
alter table private.venue_owners enable row level security;
revoke all on private.account_roles, private.venue_owners from public, anon, authenticated, service_role;
grant select on private.account_roles, private.venue_owners to service_role;
-- Even service-role callers use the actor-checked assignment functions below.
-- No client RLS policies: accidental future grants still expose no rows.

create function private.has_account_role(actor_user_id uuid, required_role public.privileged_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select actor_user_id is not null and exists (
    select 1 from private.account_roles r
    where r.user_id = actor_user_id and r.role = required_role
  );
$$;
create function private.can_review_venues(actor_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.has_account_role(actor_user_id, 'admin')
    or private.has_account_role(actor_user_id, 'moderator');
$$;
create function private.is_verified_venue_owner(actor_user_id uuid, target_venue_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select actor_user_id is not null and exists (
    select 1 from private.venue_owners o join public.venues v on v.id = o.venue_id
    where o.user_id = actor_user_id and o.venue_id = target_venue_id
      and v.claim_status = 'verified' and v.publication_status = 'approved'
  );
$$;
create function private.can_manage_venue(actor_user_id uuid, target_venue_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.venues v where v.id = target_venue_id)
    and (private.has_account_role(actor_user_id, 'admin')
      or private.is_verified_venue_owner(actor_user_id, target_venue_id));
$$;

revoke all on function private.has_account_role(uuid, public.privileged_role),
  private.can_review_venues(uuid), private.is_verified_venue_owner(uuid, uuid),
  private.can_manage_venue(uuid, uuid) from public, anon, authenticated;
grant execute on function private.has_account_role(uuid, public.privileged_role),
  private.can_review_venues(uuid), private.is_verified_venue_owner(uuid, uuid),
  private.can_manage_venue(uuid, uuid) to service_role;

-- Self-only read for UI decisions. Always read current DB assignments, never
-- role/team claims cached in JWTs or writable user_metadata. No target user arg.
create function public.my_account_access()
returns table (privileged_roles public.privileged_role[], owned_venue_ids uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare caller_id uuid := auth.uid();
begin
  if caller_id is null or not exists (select 1 from public.profiles p where p.id = caller_id) then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  return query select
    array(select r.role from private.account_roles r where r.user_id = caller_id order by r.role),
    array(select o.venue_id from private.venue_owners o
      where o.user_id = caller_id and private.is_verified_venue_owner(caller_id, o.venue_id)
      order by o.venue_id);
end;
$$;
revoke all on function public.my_account_access() from public, anon, authenticated;
grant execute on function public.my_account_access() to authenticated;

-- Trusted server primitives. actor_user_id MUST come from a server-verified
-- user token, never request JSON. service_role is an infrastructure credential,
-- not an application administrator. Bootstrap the first admin with trusted SQL.
create function public.set_account_role(
  actor_user_id uuid, target_user_id uuid, assigned_role public.privileged_role, enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_account_role(actor_user_id, 'admin') then
    raise exception 'Administrator authorization required' using errcode = '42501';
  end if;
  if target_user_id is null or assigned_role is null or enabled is null
    or not exists (select 1 from public.profiles p where p.id = target_user_id) then
    raise exception 'Invalid role assignment' using errcode = '22023';
  end if;
  if enabled then
    insert into private.account_roles(user_id, role, granted_by)
      values (target_user_id, assigned_role, actor_user_id)
      on conflict (user_id, role) do nothing;
  else
    delete from private.account_roles r where r.user_id = target_user_id and r.role = assigned_role;
  end if;
end;
$$;
create function public.set_verified_venue_owner(
  actor_user_id uuid, target_venue_id uuid, owner_user_id uuid, enabled boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare venue_claim public.venue_claim_status;
begin
  if not private.can_review_venues(actor_user_id) then
    raise exception 'Venue-review authorization required' using errcode = '42501';
  end if;
  if enabled is null or owner_user_id is null
    or not exists (select 1 from public.profiles p where p.id = owner_user_id) then
    raise exception 'Invalid ownership assignment' using errcode = '22023';
  end if;
  select v.claim_status into venue_claim from public.venues v where v.id = target_venue_id for update;
  if not found then
    raise exception 'Invalid ownership assignment' using errcode = '22023';
  end if;
  if enabled then
    if venue_claim <> 'verified' then
      raise exception 'Venue must already be verified' using errcode = '42501';
    end if;
    insert into private.venue_owners(venue_id, user_id, verified_by)
      values (target_venue_id, owner_user_id, actor_user_id)
      on conflict (venue_id, user_id) do nothing;
  else
    delete from private.venue_owners o where o.venue_id = target_venue_id and o.user_id = owner_user_id;
  end if;
end;
$$;
create function public.authorize_venue_management(actor_user_id uuid, target_venue_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage_venue(actor_user_id, target_venue_id) then
    raise exception 'Venue-management authorization required' using errcode = '42501';
  end if;
end;
$$;
revoke all on function public.set_account_role(uuid, uuid, public.privileged_role, boolean),
  public.set_verified_venue_owner(uuid, uuid, uuid, boolean),
  public.authorize_venue_management(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_account_role(uuid, uuid, public.privileged_role, boolean),
  public.set_verified_venue_owner(uuid, uuid, uuid, boolean),
  public.authorize_venue_management(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
