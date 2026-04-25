-- Add support for plant photos stored in Supabase Storage.

alter table if exists public.plants
  add column if not exists photo_path text;

-- Keep room details payload compatible with frontend signed photo URLs.
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
        select id, room_id, name, species, status, last_watered_at, photo_path, created_at
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
