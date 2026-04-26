-- Add generated cartoon room backgrounds.
-- Run after security_hardening.sql and multi_household_delete_room.sql.

alter table if exists public.rooms
  add column if not exists stylized_background_path text;

drop function if exists public.api_list_rooms(text);
create or replace function public.api_list_rooms(
  p_telegram_id text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text,
  stylized_background_path text
)
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

  return query
  select r.id, r.name, r.background_path, r.background_url, r.stylized_background_path
  from public.rooms r
  where r.household_id = v_household_id
  order by r.created_at asc;
end
$$;

drop function if exists public.api_create_room(text, text);
create or replace function public.api_create_room(
  p_telegram_id text,
  p_name text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text,
  stylized_background_path text
)
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
  perform public.api_assert_room_create_allowed(v_profile_id);

  return query
  with inserted_room as (
    insert into public.rooms (household_id, name)
    values (v_household_id, nullif(btrim(p_name), ''))
    returning
      rooms.id,
      rooms.name,
      rooms.background_path,
      rooms.background_url,
      rooms.stylized_background_path,
      rooms.household_id
  ),
  inserted_event as (
    insert into public.room_create_events (profile_id, household_id)
    select v_profile_id, ir.household_id
    from inserted_room ir
    returning id
  )
  select ir.id, ir.name, ir.background_path, ir.background_url, ir.stylized_background_path
  from inserted_room ir;
end
$$;

drop function if exists public.api_rename_room(text, uuid, text);
create or replace function public.api_rename_room(
  p_telegram_id text,
  p_room_id uuid,
  p_name text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text,
  stylized_background_path text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_label text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);
  v_label := coalesce(nullif(btrim(p_name), ''), 'Room');

  update public.rooms r
  set name = v_label
  where r.id = p_room_id
    and r.household_id = v_household_id;

  if not found then
    raise exception 'room not found or forbidden';
  end if;

  return query
  select r.id, r.name, r.background_path, r.background_url, r.stylized_background_path
  from public.rooms r
  where r.id = p_room_id;
end
$$;

drop function if exists public.api_attach_room_image(text, uuid, text);
create or replace function public.api_attach_room_image(
  p_telegram_id text,
  p_room_id uuid,
  p_file_path text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text,
  stylized_background_path text
)
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

  update public.rooms r
  set background_path = p_file_path,
      background_url = null,
      stylized_background_path = null
  where r.id = p_room_id
    and r.household_id = v_household_id;

  if not found then
    raise exception 'room not found in household';
  end if;

  return query
  select r.id, r.name, r.background_path, r.background_url, r.stylized_background_path
  from public.rooms r
  where r.id = p_room_id;
end
$$;

grant execute on function public.api_list_rooms(text) to anon, authenticated, service_role;
grant execute on function public.api_create_room(text, text) to anon, authenticated, service_role;
grant execute on function public.api_rename_room(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.api_attach_room_image(text, uuid, text) to anon, authenticated, service_role;
