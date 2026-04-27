-- Guard: keep plants.household_id consistent with rooms.household_id.
-- Safe to run multiple times.

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
