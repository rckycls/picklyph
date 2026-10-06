-- T12: attributable successful directory commands; no request/evidence snapshots.
-- IDs intentionally have no cascading FK: deleting an account/venue must not
-- silently erase history. Retention/account-deletion policy belongs to T47.
create table private.directory_audit_events (
  id bigint generated always as identity primary key,
  actor_user_id uuid not null,
  target_venue_id uuid not null,
  action text not null check (action in (
    'directory.create', 'directory.update', 'directory.publish',
    'directory.unpublish', 'directory.suspend', 'directory.import'
  )),
  occurred_at timestamptz not null default clock_timestamp()
);
create index directory_audit_events_venue_id on private.directory_audit_events(target_venue_id, id);
alter table private.directory_audit_events enable row level security;
revoke all on private.directory_audit_events from public, anon, authenticated, service_role;
revoke all on sequence private.directory_audit_events_id_seq from public, anon, authenticated, service_role;

-- Keep the proven mutation/role-lock implementations private. Only the new
-- audited public commands are callable by the trusted server.
alter function public.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb) set schema private;
alter function public.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status) set schema private;
revoke all on function private.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb),
  private.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status)
  from public, anon, authenticated, service_role;

create function public.directory_admin_save(actor_user_id uuid, target_venue_id uuid, expected_updated_at timestamptz,
  venue_input jsonb, court_inputs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved jsonb;
begin
  saved := private.directory_admin_save(actor_user_id,target_venue_id,expected_updated_at,venue_input,court_inputs);
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
    values (actor_user_id,(saved ->> 'id')::uuid,
      case when target_venue_id is null then 'directory.create' else 'directory.update' end);
  return saved;
end;
$$;

create function public.directory_admin_publish(actor_user_id uuid, target_venue_id uuid,
  expected_updated_at timestamptz, new_status public.venue_publication_status) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare saved jsonb;
begin
  saved := private.directory_admin_publish(actor_user_id,target_venue_id,expected_updated_at,new_status);
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
    values (actor_user_id,target_venue_id,case new_status
      when 'approved' then 'directory.publish' when 'draft' then 'directory.unpublish' else 'directory.suspend' end);
  return saved;
end;
$$;

create or replace function public.directory_admin_import(actor_user_id uuid, listings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare entry jsonb; ref text; existing_ref private.directory_import_refs%rowtype; saved jsonb; result jsonb := '[]';
begin
  perform private.require_directory_admin(actor_user_id);
  if jsonb_typeof(listings) is distinct from 'array' then raise exception 'Invalid import' using errcode = '22023'; end if;
  if jsonb_array_length(listings) not between 1 and 25 then raise exception 'Import 1 to 25 listings' using errcode = '22023'; end if;
  for entry in select value from jsonb_array_elements(listings) loop
    if jsonb_typeof(entry) is distinct from 'object' then raise exception 'Invalid import entry' using errcode = '22023'; end if;
    if not entry ?& array['reference','venue','courts'] or (select count(*) from jsonb_object_keys(entry)) <> 3
      or jsonb_typeof(entry -> 'reference') is distinct from 'string' or char_length(btrim(entry ->> 'reference')) not between 1 and 120 then
      raise exception 'Invalid import reference or fields' using errcode = '22023';
    end if;
    perform private.validate_directory_input(entry -> 'venue', entry -> 'courts');
    if exists(select 1 from jsonb_array_elements(entry -> 'courts') c where c ->> 'id' is not null) then
      raise exception 'Imports cannot reuse court identifiers' using errcode = '22023';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(listings) e group by btrim(e ->> 'reference') having count(*) > 1) then
    raise exception 'Duplicate import references' using errcode = '22023';
  end if;
  for entry in select value from jsonb_array_elements(listings) order by btrim(value ->> 'reference') loop
    ref := btrim(entry ->> 'reference');
    perform pg_advisory_xact_lock(hashtextextended('pickly:directory-import:' || ref, 0));
    select r.* into existing_ref from private.directory_import_refs r where r.reference=ref;
    if found then
      if existing_ref.original_input <> entry then raise exception 'Import reference has different data; edit its listing instead' using errcode = '23505'; end if;
      result := result || jsonb_build_array(jsonb_build_object('reference',ref,'id',existing_ref.venue_id,'outcome','existing'));
    else
      -- Use the private implementation to record exactly one import event,
      -- rather than also recording a manual-create event for this nested save.
      saved := private.directory_admin_save(actor_user_id,null,null,entry -> 'venue',entry -> 'courts');
      insert into private.directory_import_refs(reference,venue_id,original_input) values (ref,(saved ->> 'id')::uuid,entry);
      insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
        values (actor_user_id,(saved ->> 'id')::uuid,'directory.import');
      result := result || jsonb_build_array(jsonb_build_object('reference',ref,'id',saved ->> 'id','outcome','created'));
    end if;
  end loop;
  return result;
end;
$$;

-- Same admin-only matrix as directory curation. No direct table read, including
-- service_role. The server must derive actor_user_id from a verified user.
create function public.directory_admin_audit_read(actor_user_id uuid, target_venue_id uuid default null, after_id bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; next_id bigint;
begin
  perform private.require_directory_admin(actor_user_id);
  if after_id is not null and after_id < 0 then raise exception 'Invalid audit cursor' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'actor_user_id',e.actor_user_id,
    'target_venue_id',e.target_venue_id,'action',e.action,'occurred_at',e.occurred_at) order by e.id),'[]'::jsonb), max(e.id)
    into result,next_id from (
      select * from private.directory_audit_events a where ($2 is null or a.target_venue_id=$2)
        and ($3 is null or a.id > $3) order by a.id limit 100
    ) e;
  return jsonb_build_object('items',result,'next_cursor',case when exists (
    select 1 from private.directory_audit_events a where a.id > next_id
      and ($2 is null or a.target_venue_id=$2)
  ) then next_id::text else null end);
end;
$$;

revoke all on function public.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb),
  public.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status),
  public.directory_admin_import(uuid,jsonb), public.directory_admin_audit_read(uuid,uuid,bigint) from public, anon, authenticated;
grant execute on function public.directory_admin_save(uuid,uuid,timestamptz,jsonb,jsonb),
  public.directory_admin_publish(uuid,uuid,timestamptz,public.venue_publication_status),
  public.directory_admin_import(uuid,jsonb), public.directory_admin_audit_read(uuid,uuid,bigint) to service_role;
notify pgrst, 'reload schema';
