-- Rename plant watering thresholds from minutes to hours.
-- Applies to existing databases that already have *_minutes columns/functions.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'plants'
      and column_name = 'thirsty_after_minutes'
  ) then
    execute 'alter table public.plants rename column thirsty_after_minutes to thirsty_after_hours';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'plants'
      and column_name = 'overdue_after_minutes'
  ) then
    execute 'alter table public.plants rename column overdue_after_minutes to overdue_after_hours';
  end if;
end
$$;

do $$
declare
  v_thirsty_type text;
  v_thirsty_scale integer;
  v_overdue_type text;
  v_overdue_scale integer;
begin
  select data_type, numeric_scale
    into v_thirsty_type, v_thirsty_scale
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'plants'
    and column_name = 'thirsty_after_hours';

  select data_type, numeric_scale
    into v_overdue_type, v_overdue_scale
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'plants'
    and column_name = 'overdue_after_hours';

  if v_thirsty_type in ('smallint', 'integer', 'bigint')
     or (v_thirsty_type = 'numeric' and coalesce(v_thirsty_scale, 0) = 0) then
    execute 'alter table public.plants alter column thirsty_after_hours type numeric(10,2) using round((thirsty_after_hours::numeric / 60.0), 2)';
  else
    execute 'alter table public.plants alter column thirsty_after_hours type numeric(10,2) using round(thirsty_after_hours::numeric, 2)';
  end if;

  if v_overdue_type in ('smallint', 'integer', 'bigint')
     or (v_overdue_type = 'numeric' and coalesce(v_overdue_scale, 0) = 0) then
    execute 'alter table public.plants alter column overdue_after_hours type numeric(10,2) using round((overdue_after_hours::numeric / 60.0), 2)';
  else
    execute 'alter table public.plants alter column overdue_after_hours type numeric(10,2) using round(overdue_after_hours::numeric, 2)';
  end if;

  execute 'alter table public.plants alter column thirsty_after_hours set default 0.1';
  execute 'alter table public.plants alter column overdue_after_hours set default 1.0';
end
$$;

alter table if exists public.plants
  drop constraint if exists plants_thirsty_after_minutes_check;
alter table if exists public.plants
  drop constraint if exists plants_overdue_after_minutes_check;
alter table if exists public.plants
  drop constraint if exists plants_thirsty_after_hours_check;
alter table if exists public.plants
  drop constraint if exists plants_overdue_after_hours_check;

alter table if exists public.plants
  add constraint plants_thirsty_after_hours_check
  check (thirsty_after_hours > 0);

alter table if exists public.plants
  add constraint plants_overdue_after_hours_check
  check (overdue_after_hours > 0 and overdue_after_hours >= thirsty_after_hours);

create or replace function public.api_room_details(
  p_telegram_id text,
  p_room_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_room_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  select r.household_id into v_room_household_id
  from public.rooms r
  where r.id = p_room_id;

  if v_room_household_id is null then
    raise exception 'room not found';
  end if;
  if v_room_household_id <> v_household_id then
    raise exception 'forbidden room access';
  end if;

  return jsonb_build_object(
    'plants', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at asc), '[]'::jsonb)
      from (
        select
          id,
          room_id,
          name,
          species,
          status,
          last_watered_at,
          photo_path,
          thirsty_after_hours,
          overdue_after_hours,
          created_at
        from public.plants
        where room_id = p_room_id and household_id = v_household_id
      ) p
    ),
    'markers', (
      select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at asc), '[]'::jsonb)
      from (
        select id, plant_id, room_id, x, y, created_at
        from public.plant_markers
        where room_id = p_room_id
      ) m
    )
  );
end
$$;

drop function if exists public.api_create_plant(text, uuid, text, text, text, integer, integer);
create or replace function public.api_create_plant(
  p_telegram_id text,
  p_room_id uuid,
  p_name text,
  p_species text,
  p_status text,
  p_thirsty_after_hours numeric default 0.1,
  p_overdue_after_hours numeric default 1.0
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_room_household_id uuid;
  v_last_watered timestamp with time zone;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  select r.household_id into v_room_household_id
  from public.rooms r
  where r.id = p_room_id;

  if v_room_household_id is null then
    raise exception 'room not found';
  end if;
  if v_room_household_id <> v_household_id then
    raise exception 'forbidden room access';
  end if;

  if p_status not in ('healthy', 'thirsty', 'overdue') then
    raise exception 'invalid plant status';
  end if;
  if p_thirsty_after_hours is null or p_thirsty_after_hours <= 0 then
    raise exception 'invalid thirsty threshold';
  end if;
  if p_overdue_after_hours is null or p_overdue_after_hours <= 0 then
    raise exception 'invalid overdue threshold';
  end if;
  if p_overdue_after_hours < p_thirsty_after_hours then
    raise exception 'invalid watering thresholds';
  end if;

  if p_status = 'healthy' then
    v_last_watered := now();
  else
    v_last_watered := null;
  end if;

  return query
  insert into public.plants (
    household_id,
    room_id,
    name,
    species,
    status,
    last_watered_at,
    thirsty_after_hours,
    overdue_after_hours
  )
  values (
    v_household_id,
    p_room_id,
    nullif(btrim(p_name), ''),
    nullif(btrim(p_species), ''),
    p_status,
    v_last_watered,
    round(p_thirsty_after_hours, 2),
    round(p_overdue_after_hours, 2)
  )
  returning plants.id;
end
$$;

drop function if exists public.api_update_plant(text, uuid, text, text, text, integer, integer);
create or replace function public.api_update_plant(
  p_telegram_id text,
  p_plant_id uuid,
  p_name text,
  p_species text,
  p_status text,
  p_thirsty_after_hours numeric default 0.1,
  p_overdue_after_hours numeric default 1.0
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  if p_status not in ('healthy', 'thirsty', 'overdue') then
    raise exception 'invalid plant status';
  end if;
  if p_thirsty_after_hours is null or p_thirsty_after_hours <= 0 then
    raise exception 'invalid thirsty threshold';
  end if;
  if p_overdue_after_hours is null or p_overdue_after_hours <= 0 then
    raise exception 'invalid overdue threshold';
  end if;
  if p_overdue_after_hours < p_thirsty_after_hours then
    raise exception 'invalid watering thresholds';
  end if;

  update public.plants p
  set name = nullif(btrim(p_name), ''),
      species = nullif(btrim(p_species), ''),
      status = p_status,
      thirsty_after_hours = round(p_thirsty_after_hours, 2),
      overdue_after_hours = round(p_overdue_after_hours, 2),
      ai_inferred_at = null
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if not found then
    raise exception 'plant not found in household';
  end if;

  return query select p_plant_id;
end
$$;

grant execute on function public.api_create_plant(text, uuid, text, text, text, numeric, numeric)
  to anon, authenticated, service_role;
grant execute on function public.api_update_plant(text, uuid, text, text, text, numeric, numeric)
  to anon, authenticated, service_role;
