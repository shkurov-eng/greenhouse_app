-- Per-plant watering threshold settings (in minutes).
-- Defaults match current client behavior: thirsty after 5m, overdue after 60m.

alter table if exists public.plants
  add column if not exists thirsty_after_minutes integer not null default 5;

alter table if exists public.plants
  add column if not exists overdue_after_minutes integer not null default 60;

alter table if exists public.plants
  add column if not exists photo_path text;

alter table if exists public.plants
  drop constraint if exists plants_thirsty_after_minutes_check;

alter table if exists public.plants
  add constraint plants_thirsty_after_minutes_check
  check (thirsty_after_minutes > 0);

alter table if exists public.plants
  drop constraint if exists plants_overdue_after_minutes_check;

alter table if exists public.plants
  add constraint plants_overdue_after_minutes_check
  check (overdue_after_minutes > 0 and overdue_after_minutes >= thirsty_after_minutes);

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
          thirsty_after_minutes,
          overdue_after_minutes,
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

create or replace function public.api_create_plant(
  p_telegram_id text,
  p_room_id uuid,
  p_name text,
  p_species text,
  p_status text,
  p_thirsty_after_minutes integer default 5,
  p_overdue_after_minutes integer default 60
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
  if p_thirsty_after_minutes is null or p_thirsty_after_minutes <= 0 then
    raise exception 'invalid thirsty threshold';
  end if;
  if p_overdue_after_minutes is null or p_overdue_after_minutes <= 0 then
    raise exception 'invalid overdue threshold';
  end if;
  if p_overdue_after_minutes < p_thirsty_after_minutes then
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
    thirsty_after_minutes,
    overdue_after_minutes
  )
  values (
    v_household_id,
    p_room_id,
    nullif(btrim(p_name), ''),
    nullif(btrim(p_species), ''),
    p_status,
    v_last_watered,
    p_thirsty_after_minutes,
    p_overdue_after_minutes
  )
  returning plants.id;
end
$$;

create or replace function public.api_update_plant(
  p_telegram_id text,
  p_plant_id uuid,
  p_name text,
  p_species text,
  p_status text,
  p_thirsty_after_minutes integer default 5,
  p_overdue_after_minutes integer default 60
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
  if p_thirsty_after_minutes is null or p_thirsty_after_minutes <= 0 then
    raise exception 'invalid thirsty threshold';
  end if;
  if p_overdue_after_minutes is null or p_overdue_after_minutes <= 0 then
    raise exception 'invalid overdue threshold';
  end if;
  if p_overdue_after_minutes < p_thirsty_after_minutes then
    raise exception 'invalid watering thresholds';
  end if;

  update public.plants p
  set name = nullif(btrim(p_name), ''),
      species = nullif(btrim(p_species), ''),
      status = p_status,
      thirsty_after_minutes = p_thirsty_after_minutes,
      overdue_after_minutes = p_overdue_after_minutes
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if not found then
    raise exception 'plant not found in household';
  end if;

  return query select p_plant_id;
end
$$;

grant execute on function public.api_create_plant(text, uuid, text, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.api_update_plant(text, uuid, text, text, text, integer, integer)
  to anon, authenticated, service_role;
