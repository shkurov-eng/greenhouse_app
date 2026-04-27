-- Data healing: align plants.household_id with rooms.household_id.
-- Run after fix_room_details_plants_by_room.sql.

begin;

-- Preview mismatches before update.
-- Expect 0 rows after successful run.
select
  p.id as plant_id,
  p.household_id as plant_household_id,
  r.household_id as room_household_id,
  p.room_id
from public.plants p
join public.rooms r on r.id = p.room_id
where p.household_id is distinct from r.household_id;

-- Heal mismatched rows.
update public.plants p
set household_id = r.household_id
from public.rooms r
where r.id = p.room_id
  and p.household_id is distinct from r.household_id;

-- Verify result.
select count(*) as remaining_mismatches
from public.plants p
join public.rooms r on r.id = p.room_id
where p.household_id is distinct from r.household_id;

commit;
