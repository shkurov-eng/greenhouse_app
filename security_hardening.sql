-- Security hardening migration:
-- - enables RLS for app tables
-- - revokes direct anon/authenticated table access
-- - adds SECURITY DEFINER RPC functions for app operations
-- - switches rooms bucket to private storage flow

create extension if not exists pgcrypto;

alter table if exists public.rooms
  add column if not exists background_path text;

do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles',
    'households',
    'household_members',
    'rooms',
    'plants',
    'plant_markers',
    'tasks'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

revoke all on all sequences in schema public from anon, authenticated;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'rooms') then
    update storage.buckets
    set public = false
    where id = 'rooms';
  end if;
end
$$;

drop policy if exists "Rooms bucket public read" on storage.objects;
drop policy if exists "Rooms bucket public upload" on storage.objects;
drop policy if exists "Rooms bucket public update" on storage.objects;
drop policy if exists "rooms_service_role_select" on storage.objects;
drop policy if exists "rooms_service_role_insert" on storage.objects;
drop policy if exists "rooms_service_role_update" on storage.objects;

create policy "rooms_service_role_select"
on storage.objects
for select
to service_role
using (bucket_id = 'rooms');

create policy "rooms_service_role_insert"
on storage.objects
for insert
to service_role
with check (bucket_id = 'rooms');

create policy "rooms_service_role_update"
on storage.objects
for update
to service_role
using (bucket_id = 'rooms')
with check (bucket_id = 'rooms');

create or replace function public.api_generate_invite_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text := '';
  i integer;
begin
  for i in 1..6 loop
    candidate := candidate || substr(chars, 1 + floor(random() * length(chars))::int, 1);
  end loop;
  return candidate;
end
$$;

create or replace function public.api_profile_id_by_telegram(p_telegram_id text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  if p_telegram_id is null or btrim(p_telegram_id) = '' then
    raise exception 'telegram id is required';
  end if;

  select p.id
  into v_profile_id
  from public.profiles p
  where p.telegram_id = p_telegram_id::bigint
  limit 1;

  if v_profile_id is null then
    raise exception 'profile not found';
  end if;

  return v_profile_id;
end
$$;

create or replace function public.api_household_id_by_profile(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_household_id uuid;
begin
  select hm.household_id
  into v_household_id
  from public.household_members hm
  where hm.user_id = p_profile_id
  limit 1;

  if v_household_id is null then
    raise exception 'user is not linked to a household';
  end if;

  return v_household_id;
end
$$;

create or replace function public.api_bootstrap_user(
  p_telegram_id text,
  p_username text default null
)
returns table(profile_id uuid, household_id uuid, household_name text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_invite_code text;
begin
  insert into public.profiles (telegram_id, username)
  values (p_telegram_id::bigint, nullif(btrim(p_username), ''))
  on conflict (telegram_id)
  do update set username = excluded.username;

  select p.id
  into v_profile_id
  from public.profiles p
  where p.telegram_id = p_telegram_id::bigint
  limit 1;

  select hm.household_id
  into v_household_id
  from public.household_members hm
  where hm.user_id = v_profile_id
  limit 1;

  if v_household_id is null then
    loop
      v_invite_code := public.api_generate_invite_code();
      begin
        insert into public.households (name, invite_code)
        values ('My Home', v_invite_code)
        returning id into v_household_id;
        exit;
      exception
        when unique_violation then
          -- Retry invite code generation.
      end;
    end loop;

    insert into public.household_members (household_id, user_id)
    values (v_household_id, v_profile_id);
  end if;

  return query
  select
    v_profile_id,
    h.id,
    h.name,
    h.invite_code
  from public.households h
  where h.id = v_household_id;
end
$$;

create or replace function public.api_join_household(
  p_telegram_id text,
  p_invite_code text
)
returns table(household_id uuid, household_name text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_target_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select h.id
  into v_target_household_id
  from public.households h
  where h.invite_code = upper(btrim(p_invite_code))
  limit 1;

  if v_target_household_id is null then
    raise exception 'invite code not found';
  end if;

  update public.household_members hm
  set household_id = v_target_household_id
  where hm.user_id = v_profile_id;

  if not found then
    insert into public.household_members (household_id, user_id)
    values (v_target_household_id, v_profile_id);
  end if;

  return query
  select h.id, h.name, h.invite_code
  from public.households h
  where h.id = v_target_household_id;
end
$$;

create or replace function public.api_list_rooms(
  p_telegram_id text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text
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
  select r.id, r.name, r.background_path, r.background_url
  from public.rooms r
  where r.household_id = v_household_id
  order by r.created_at asc;
end
$$;

create or replace function public.api_create_room(
  p_telegram_id text,
  p_name text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text
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
  insert into public.rooms (household_id, name)
  values (v_household_id, nullif(btrim(p_name), ''))
  returning rooms.id, rooms.name, rooms.background_path, rooms.background_url;
end
$$;

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
        select id, room_id, name, species, status, last_watered_at, created_at
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
  p_status text
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

  if p_status = 'healthy' then
    v_last_watered := now();
  else
    v_last_watered := null;
  end if;

  return query
  insert into public.plants (household_id, room_id, name, species, status, last_watered_at)
  values (v_household_id, p_room_id, nullif(btrim(p_name), ''), nullif(btrim(p_species), ''), p_status, v_last_watered)
  returning plants.id;
end
$$;

create or replace function public.api_water_plant(
  p_telegram_id text,
  p_plant_id uuid
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

  update public.plants p
  set last_watered_at = now(),
      status = 'healthy'
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if not found then
    raise exception 'plant not found in household';
  end if;

  return query select p_plant_id;
end
$$;

create or replace function public.api_update_plant(
  p_telegram_id text,
  p_plant_id uuid,
  p_name text,
  p_species text,
  p_status text
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

  update public.plants p
  set name = nullif(btrim(p_name), ''),
      species = nullif(btrim(p_species), ''),
      status = p_status
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if not found then
    raise exception 'plant not found in household';
  end if;

  return query select p_plant_id;
end
$$;

create or replace function public.api_upsert_marker(
  p_telegram_id text,
  p_room_id uuid,
  p_plant_id uuid,
  p_x double precision,
  p_y double precision
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
  v_plant_room_id uuid;
  v_marker_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  if p_x < 0 or p_x > 1 or p_y < 0 or p_y > 1 then
    raise exception 'marker coordinates must be in range 0..1';
  end if;

  select r.household_id into v_room_household_id
  from public.rooms r
  where r.id = p_room_id;

  if v_room_household_id is null then
    raise exception 'room not found';
  end if;
  if v_room_household_id <> v_household_id then
    raise exception 'forbidden room access';
  end if;

  select p.room_id into v_plant_room_id
  from public.plants p
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if v_plant_room_id is null then
    raise exception 'plant not found in household';
  end if;
  if v_plant_room_id <> p_room_id then
    raise exception 'plant does not belong to room';
  end if;

  insert into public.plant_markers (plant_id, room_id, x, y)
  values (p_plant_id, p_room_id, p_x, p_y)
  on conflict (plant_id)
  do update set
    room_id = excluded.room_id,
    x = excluded.x,
    y = excluded.y
  returning plant_markers.id into v_marker_id;

  return query select v_marker_id;
end
$$;

create or replace function public.api_prepare_room_image_upload(
  p_telegram_id text,
  p_room_id uuid,
  p_file_name text
)
returns table(room_id uuid, file_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_room_household_id uuid;
  v_safe_name text;
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

  v_safe_name := regexp_replace(coalesce(p_file_name, 'room-image.jpg'), '[^a-zA-Z0-9._-]', '_', 'g');
  file_path := v_household_id::text || '/' || p_room_id::text || '/' || extract(epoch from now())::bigint || '-' || v_safe_name;
  room_id := p_room_id;
  return next;
end
$$;

create or replace function public.api_attach_room_image(
  p_telegram_id text,
  p_room_id uuid,
  p_file_path text
)
returns table(
  id uuid,
  name text,
  background_path text,
  background_url text
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
      background_url = null
  where r.id = p_room_id
    and r.household_id = v_household_id;

  if not found then
    raise exception 'room not found in household';
  end if;

  return query
  select r.id, r.name, r.background_path, r.background_url
  from public.rooms r
  where r.id = p_room_id;
end
$$;

revoke all on function public.api_generate_invite_code() from public;
revoke all on function public.api_profile_id_by_telegram(text) from public;
revoke all on function public.api_household_id_by_profile(uuid) from public;

grant execute on function public.api_bootstrap_user(text, text) to anon, authenticated, service_role;
grant execute on function public.api_join_household(text, text) to anon, authenticated, service_role;
grant execute on function public.api_list_rooms(text) to anon, authenticated, service_role;
grant execute on function public.api_create_room(text, text) to anon, authenticated, service_role;
grant execute on function public.api_room_details(text, uuid) to anon, authenticated, service_role;
grant execute on function public.api_create_plant(text, uuid, text, text, text) to anon, authenticated, service_role;
grant execute on function public.api_water_plant(text, uuid) to anon, authenticated, service_role;
grant execute on function public.api_update_plant(text, uuid, text, text, text) to anon, authenticated, service_role;
grant execute on function public.api_upsert_marker(text, uuid, uuid, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.api_prepare_room_image_upload(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.api_attach_room_image(text, uuid, text) to anon, authenticated, service_role;
