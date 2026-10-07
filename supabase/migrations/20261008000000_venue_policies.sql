-- T20: independent policy versions; merchant activation is trusted operator state.
-- No activation API exists until T36 defines verified provider onboarding.
create table private.venue_merchants (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  active boolean not null default false
);
create table private.venue_policies (
  venue_id uuid primary key references public.venues(id) on delete cascade,
  confirmation text not null default 'instant' check (confirmation in ('instant','approval')),
  payment text not null default 'arrival' check (payment in ('arrival','online','both')),
  revision bigint not null default 1 check (revision > 0)
);
alter table private.venue_merchants enable row level security;
alter table private.venue_policies enable row level security;
revoke all on private.venue_merchants, private.venue_policies from public, anon, authenticated, service_role;

alter table private.directory_audit_events drop constraint directory_audit_events_action_check,
  add constraint directory_audit_events_action_check check (action in (
  'directory.create','directory.update','directory.publish','directory.unpublish','directory.suspend','directory.import',
  'owner.update','owner.photo_add','owner.photo_remove','schedule.update','policy.update'));

create function private.venue_policy_view(target_venue_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('venue_id', target_venue_id, 'revision', coalesce(p.revision,0)::text,
    'confirmation', coalesce(p.confirmation,'instant'),
    -- A lost activation never offers online payment, including in future booking readers.
    'payment', case when coalesce(m.active,false) then coalesce(p.payment,'arrival') else 'arrival' end,
    'merchant_active', coalesce(m.active,false))
  from (select target_venue_id as id) v
  left join private.venue_policies p on p.venue_id=v.id
  left join private.venue_merchants m on m.venue_id=v.id;
$$;

create function public.owner_venue_policy_read(actor_user_id uuid, target_venue_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.venue_owners where user_id=actor_user_id and venue_id=target_venue_id) then
    raise exception 'Owner required' using errcode='42501', hint='not_owner';
  end if;
  if not private.is_verified_venue_owner(actor_user_id,target_venue_id) then
    raise exception 'Venue unavailable' using errcode='P0002', hint='venue_unavailable';
  end if;
  return private.venue_policy_view(target_venue_id);
end;
$$;

create function public.owner_venue_policy_save(actor_user_id uuid, target_venue_id uuid,
  expected_revision text, policy_input jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_revision bigint; merchant_active boolean;
begin
  perform private.require_venue_owner(actor_user_id,target_venue_id);
  if jsonb_typeof(policy_input) is distinct from 'object' then
    raise exception 'Invalid policy' using errcode='22023', hint='invalid_input';
  end if;
  if not policy_input ?& array['confirmation','payment'] or (select count(*) from jsonb_object_keys(policy_input))<>2
    or jsonb_typeof(policy_input->'confirmation') is distinct from 'string'
    or jsonb_typeof(policy_input->'payment') is distinct from 'string'
    or policy_input->>'confirmation' not in ('instant','approval')
    or policy_input->>'payment' not in ('arrival','online','both')
    or expected_revision is null or expected_revision !~ '^(0|[1-9][0-9]{0,18})$' then
    raise exception 'Invalid policy' using errcode='22023', hint='invalid_input';
  end if;
  select revision into current_revision from private.venue_policies where venue_id=target_venue_id;
  if coalesce(current_revision,0)::text <> expected_revision then
    raise exception 'Policy changed' using errcode='40001', hint='version_conflict';
  end if;
  -- Venue first, then merchant. T36 activation must use this same lock order and
  -- increment policy revision when changing activation to invalidate open forms.
  select active into merchant_active from private.venue_merchants where venue_id=target_venue_id for share;
  if policy_input->>'payment' in ('online','both') and not coalesce(merchant_active,false) then
    raise exception 'Merchant activation required' using errcode='42501', hint='merchant_inactive';
  end if;
  insert into private.venue_policies(venue_id,confirmation,payment,revision)
    values(target_venue_id,policy_input->>'confirmation',policy_input->>'payment',coalesce(current_revision,0)+1)
    on conflict(venue_id) do update set confirmation=excluded.confirmation,payment=excluded.payment,revision=excluded.revision;
  insert into private.directory_audit_events(actor_user_id,target_venue_id,action)
    values(actor_user_id,target_venue_id,'policy.update');
  return private.venue_policy_view(target_venue_id);
end;
$$;

revoke all on function private.venue_policy_view(uuid) from public,anon,authenticated,service_role;
revoke all on function public.owner_venue_policy_read(uuid,uuid),
  public.owner_venue_policy_save(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.owner_venue_policy_read(uuid,uuid),
  public.owner_venue_policy_save(uuid,uuid,text,jsonb) to service_role;

notify pgrst, 'reload schema';
