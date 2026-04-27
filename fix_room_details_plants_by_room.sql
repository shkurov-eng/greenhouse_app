-- Fix: room details may show empty plants after joining another household
-- when historical plants.household_id differs from rooms.household_id.
--
-- Security is preserved because access is still gated by room ownership check:
-- 1) resolve user's active household
-- 2) verify requested room belongs to that household
-- 3) then read plants by room_id

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
