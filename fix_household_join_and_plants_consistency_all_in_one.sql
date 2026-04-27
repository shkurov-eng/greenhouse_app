-- All-in-one fix script:
-- 1) Fix api_room_details to return plants by room after room access check
-- 2) Heal historical plants.household_id mismatches
-- 3) Add trigger guard to prevent future mismatches
--
-- Safe to run multiple times.

-- ---------------------------------------------------------------------------
-- 1) API fix: room details should list plants from the requested room
-- ---------------------------------------------------------------------------
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
  v_room_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select r.household_id into v_room_household_id
  from public.rooms r
  where r.id = p_room_id;

  if v_room_household_id is null then
    raise exception 'room not found';
  end if;
  if not exists (
    select 1
    from public.household_members hm
    where hm.user_id = v_profile_id
      and hm.household_id = v_room_household_id
  ) then
    raise exception 'forbidden room access';
  end if;

  return jsonb_build_object(
    'plants', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at asc), '[]'::jsonb)
      from public.plants p
      where p.room_id = p_room_id
    ),
    'markers', (
      select coalesce(jsonb_agg(to_jsonb(m) order by m.created_at asc), '[]'::jsonb)
      from public.plant_markers m
      where m.room_id = p_room_id
    )
  );
end
$$;

-- ---------------------------------------------------------------------------
-- 2) Data healing: align plants.household_id with rooms.household_id
-- ---------------------------------------------------------------------------
begin;

-- Optional preview (read result in SQL editor)
select
  p.id as plant_id,
  p.household_id as plant_household_id,
  r.household_id as room_household_id,
  p.room_id
from public.plants p
join public.rooms r on r.id = p.room_id
where p.household_id is distinct from r.household_id;

update public.plants p
set household_id = r.household_id
from public.rooms r
where r.id = p.room_id
  and p.household_id is distinct from r.household_id;

-- Verification (should be 0)
select count(*) as remaining_mismatches
from public.plants p
join public.rooms r on r.id = p.room_id
where p.household_id is distinct from r.household_id;

commit;

-- ---------------------------------------------------------------------------
-- 3) Guard: keep plants.household_id consistent in future writes
-- ---------------------------------------------------------------------------
create or replace function public.enforce_plants_household_consistency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_room_household_id uuid;
begin
  select r.household_id
  into v_room_household_id
  from public.rooms r
  where r.id = new.room_id;

  if v_room_household_id is null then
    raise exception 'room not found for plant';
  end if;

  new.household_id := v_room_household_id;
  return new;
end
$$;

drop trigger if exists trg_plants_household_consistency on public.plants;

create trigger trg_plants_household_consistency
before insert or update of room_id, household_id
on public.plants
for each row
execute function public.enforce_plants_household_consistency();
