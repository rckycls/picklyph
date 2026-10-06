-- T13: server-only bounded discovery; existing public directory RLS is retained.
create extension if not exists pg_trgm with schema extensions;
create index venues_approved_city_lower on public.venues (lower(city), id)
  where publication_status = 'approved';
create index venues_approved_name_trgm on public.venues using gin (lower(name) extensions.gin_trgm_ops)
  where publication_status = 'approved';

create function public.directory_search(search jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  bounds jsonb; city_name text; name_query text; name_pattern text;
  south double precision; west double precision; north double precision; east double precision;
  indoor_filter boolean; covered_filter boolean; surface_filter text;
  cursor_id uuid; page_size integer; result jsonb;
begin
  if jsonb_typeof(search) is distinct from 'object' or
     search - array['bounds','city','name','indoor','covered','surface','after','limit'] <> '{}'::jsonb then
    raise exception 'Invalid search' using errcode = '22023';
  end if;
  bounds := nullif(search->'bounds', 'null'::jsonb);
  city_name := search->>'city'; name_query := search->>'name';
  if (search->'city' is not null and search->'city' <> 'null'::jsonb and jsonb_typeof(search->'city') <> 'string') or
     (search->'name' is not null and search->'name' <> 'null'::jsonb and jsonb_typeof(search->'name') <> 'string') or
     (city_name is not null and (city_name <> btrim(city_name) or char_length(city_name) not between 2 and 80 or city_name ~ '[[:cntrl:]]')) or
     (name_query is not null and (name_query <> btrim(name_query) or char_length(name_query) not between 3 and 120 or name_query ~ '[[:cntrl:]]')) or
     (bounds is null and city_name is null and name_query is null) then
    raise exception 'Invalid search selector' using errcode = '22023';
  end if;
  if bounds is not null then
    if jsonb_typeof(bounds) <> 'object' or bounds - array['south','west','north','east'] <> '{}'::jsonb or
       not (bounds ?& array['south','west','north','east']) or
       exists (select 1 from jsonb_each(bounds) where jsonb_typeof(value) <> 'number') then
      raise exception 'Invalid bounds' using errcode = '22023';
    end if;
    south := (bounds->>'south')::double precision; west := (bounds->>'west')::double precision;
    north := (bounds->>'north')::double precision; east := (bounds->>'east')::double precision;
    if not (south between -90 and 90 and north between -90 and 90 and west between -180 and 180 and east between -180 and 180
      and south <= north and west <= east and north-south <= 30 and east-west <= 30) then
      raise exception 'Invalid bounds' using errcode = '22023';
    end if;
  end if;
  if exists (select 1 from jsonb_each(search) where key in ('indoor','covered') and value <> 'null'::jsonb and jsonb_typeof(value) <> 'boolean') or
     (search->>'surface' is not null and search->>'surface' not in ('hard','synthetic','other')) or
     (search->'surface' is not null and search->'surface' <> 'null'::jsonb and jsonb_typeof(search->'surface') <> 'string') or
     (search->'after' is not null and search->'after' <> 'null'::jsonb and (jsonb_typeof(search->'after') <> 'string' or search->>'after' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) or
     (search ? 'limit' and (jsonb_typeof(search->'limit') <> 'number' or search->>'limit' !~ '^[0-9]{1,2}$')) then
    raise exception 'Invalid search filters' using errcode = '22023';
  end if;
  indoor_filter := (search->>'indoor')::boolean; covered_filter := (search->>'covered')::boolean;
  surface_filter := search->>'surface'; cursor_id := (search->>'after')::uuid;
  page_size := coalesce((search->>'limit')::integer, 25);
  if page_size not between 1 and 50 then raise exception 'Invalid page size' using errcode = '22023'; end if;
  -- Escape LIKE metacharacters so user text can never become a wildcard query.
  name_pattern := '%' || replace(replace(replace(lower(name_query), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  with matches as materialized (
    select v.id, v.name, v.address_line, v.city, v.province, v.country_code,
           v.latitude, v.longitude, v.claim_status
    from public.venues v
    where v.publication_status = 'approved'
      and (cursor_id is null or v.id > cursor_id)
      and (bounds is null or v.location operator(extensions.&&) extensions.st_makeenvelope(west,south,east,north,4326))
      and (city_name is null or lower(v.city) = lower(city_name))
      and (name_query is null or lower(v.name) like name_pattern escape E'\\')
      and ((indoor_filter is null and covered_filter is null and surface_filter is null) or exists (
        select 1 from public.courts c where c.venue_id = v.id and c.status = 'active'
          and (indoor_filter is null or c.is_indoor = indoor_filter)
          and (covered_filter is null or c.is_covered = covered_filter)
          and (surface_filter is null or c.surface::text = surface_filter)
      ))
    order by v.id limit page_size + 1
  ), page as (
    select * from matches order by id limit page_size
  )
  select jsonb_build_object(
    'venues', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object('active_court_count',
       (select count(*) from public.courts c where c.venue_id=p.id and c.status='active')) order by p.id) from page p), '[]'::jsonb),
    'next_cursor', case when (select count(*) from matches) > page_size then
       (select id::text from page order by id desc limit 1) else null end
  ) into result;
  return result;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Invalid search value' using errcode = '22023';
end;
$$;
revoke all on function public.directory_search(jsonb) from public, anon, authenticated;
grant execute on function public.directory_search(jsonb) to service_role;
