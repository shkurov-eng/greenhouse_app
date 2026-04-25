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
    'room_create_events',
    'plant_create_events',
    'ai_photo_request_events',
    'plants',
    'plant_markers',
    'tasks',
    'invite_join_attempts'
  ]
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end
$$;

create table if not exists public.invite_join_attempts (
  key text primary key,
  failures integer not null default 0,
  window_started_at timestamp with time zone not null default now(),
  blocked_until timestamp with time zone,
  updated_at timestamp with time zone not null default now()
);

create table if not exists public.room_create_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  created_at timestamp with time zone not null default now()
);

create index if not exists room_create_events_profile_created_idx
  on public.room_create_events (profile_id, created_at desc);

create table if not exists public.plant_create_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  created_at timestamp with time zone not null default now()
);

create index if not exists plant_create_events_profile_created_idx
  on public.plant_create_events (profile_id, created_at desc);

create table if not exists public.ai_photo_request_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamp with time zone not null default now()
);

create index if not exists ai_photo_request_events_profile_created_idx
  on public.ai_photo_request_events (profile_id, created_at desc);

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
  random_bytes bytea := gen_random_bytes(10);
  candidate text := '';
  i integer;
begin
  for i in 1..10 loop
    -- Use pgcrypto bytes instead of random() because invite codes gate household access.
    candidate := candidate || substr(chars, 1 + (get_byte(random_bytes, i - 1) % length(chars)), 1);
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

create or replace function public.api_assert_room_create_allowed(
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit integer := 10;
  v_day_limit integer := 50;
  v_hour_count integer;
  v_day_count integer;
begin
  if p_profile_id is null then
    raise exception 'profile id is required';
  end if;

  select count(*)
  into v_hour_count
  from public.room_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '1 hour';

  if v_hour_count >= v_hour_limit then
    raise exception 'room creation rate limit exceeded (hourly)';
  end if;

  select count(*)
  into v_day_count
  from public.room_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '24 hours';

  if v_day_count >= v_day_limit then
    raise exception 'room creation rate limit exceeded (daily)';
  end if;
end
$$;

create or replace function public.api_assert_plant_create_allowed(
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit integer := 30;
  v_day_limit integer := 150;
  v_hour_count integer;
  v_day_count integer;
begin
  if p_profile_id is null then
    raise exception 'profile id is required';
  end if;

  select count(*)
  into v_hour_count
  from public.plant_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '1 hour';

  if v_hour_count >= v_hour_limit then
    raise exception 'plant creation rate limit exceeded (hourly)';
  end if;

  select count(*)
  into v_day_count
  from public.plant_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '24 hours';

  if v_day_count >= v_day_limit then
    raise exception 'plant creation rate limit exceeded (daily)';
  end if;
end
$$;

create or replace function public.api_assert_ai_photo_request_allowed(
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit integer := 30;
  v_day_limit integer := 150;
  v_hour_count integer;
  v_day_count integer;
begin
  if p_profile_id is null then
    raise exception 'profile id is required';
  end if;

  select count(*)
  into v_hour_count
  from public.ai_photo_request_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '1 hour';

  if v_hour_count >= v_hour_limit then
    raise exception 'AI photo rate limit exceeded (hourly)';
  end if;

  select count(*)
  into v_day_count
  from public.ai_photo_request_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '24 hours';

  if v_day_count >= v_day_limit then
    raise exception 'AI photo rate limit exceeded (daily)';
  end if;
end
$$;

create or replace function public.api_register_ai_photo_request(
  p_telegram_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  perform public.api_assert_ai_photo_request_allowed(v_profile_id);

  insert into public.ai_photo_request_events (profile_id)
  values (v_profile_id);
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
  perform public.api_assert_room_create_allowed(v_profile_id);

  return query
  with inserted_room as (
    insert into public.rooms (household_id, name)
    values (v_household_id, nullif(btrim(p_name), ''))
    returning rooms.id, rooms.name, rooms.background_path, rooms.background_url, rooms.household_id
  ),
  inserted_event as (
    insert into public.room_create_events (profile_id, household_id)
    select v_profile_id, ir.household_id
    from inserted_room ir
    returning id
  )
  select ir.id, ir.name, ir.background_path, ir.background_url
  from inserted_room ir;
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
  with inserted_plant as (
    insert into public.plants (household_id, room_id, name, species, status, last_watered_at)
    values (v_household_id, p_room_id, nullif(btrim(p_name), ''), nullif(btrim(p_species), ''), p_status, v_last_watered)
    returning plants.id, plants.household_id, plants.room_id
  ),
  inserted_event as (
    insert into public.plant_create_events (profile_id, household_id, room_id)
    select v_profile_id, ip.household_id, ip.room_id
    from inserted_plant ip
    returning id
  )
  select ip.id
  from inserted_plant ip;
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

create or replace function public.api_check_join_invite_rate_limit(
  p_key text
)
returns table(is_blocked boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_blocked_until timestamp with time zone;
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'rate-limit key is required';
  end if;

  select blocked_until
  into v_blocked_until
  from public.invite_join_attempts a
  where a.key = p_key;

  if v_blocked_until is null then
    return query select false, 0;
    return;
  end if;

  if v_blocked_until <= now() then
    update public.invite_join_attempts
    set blocked_until = null,
        failures = 0,
        window_started_at = now(),
        updated_at = now()
    where key = p_key;

    return query select false, 0;
    return;
  end if;

  return query
  select true, greatest(1, ceil(extract(epoch from (v_blocked_until - now())))::int);
end
$$;

create or replace function public.api_register_join_invite_failure(
  p_key text
)
returns table(is_blocked boolean, retry_after_seconds integer, failures integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window interval := interval '15 minutes';
  v_block interval := interval '15 minutes';
  v_max_failures integer := 5;
  v_row public.invite_join_attempts%rowtype;
  v_now timestamp with time zone := now();
  v_failures integer;
  v_window_started timestamp with time zone;
  v_blocked_until timestamp with time zone;
begin
  if p_key is null or btrim(p_key) = '' then
    raise exception 'rate-limit key is required';
  end if;

  select *
  into v_row
  from public.invite_join_attempts a
  where a.key = p_key
  for update;

  if not found then
    insert into public.invite_join_attempts (key, failures, window_started_at, blocked_until, updated_at)
    values (p_key, 1, v_now, null, v_now);
    return query select false, 0, 1;
    return;
  end if;

  if v_row.blocked_until is not null and v_row.blocked_until > v_now then
    return query
    select true, greatest(1, ceil(extract(epoch from (v_row.blocked_until - v_now)))::int), v_row.failures;
    return;
  end if;

  if v_now - v_row.window_started_at > v_window then
    v_failures := 1;
    v_window_started := v_now;
  else
    v_failures := v_row.failures + 1;
    v_window_started := v_row.window_started_at;
  end if;

  if v_failures >= v_max_failures then
    v_blocked_until := v_now + v_block;
  else
    v_blocked_until := null;
  end if;

  update public.invite_join_attempts
  set failures = v_failures,
      window_started_at = v_window_started,
      blocked_until = v_blocked_until,
      updated_at = v_now
  where key = p_key;

  if v_blocked_until is null then
    return query select false, 0, v_failures;
    return;
  end if;

  return query
  select true, greatest(1, ceil(extract(epoch from (v_blocked_until - v_now)))::int), v_failures;
end
$$;

create or replace function public.api_clear_join_invite_failures(
  p_key text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_key is null or btrim(p_key) = '' then
    return;
  end if;

  delete from public.invite_join_attempts a
  where a.key = p_key;
end
$$;

revoke all on function public.api_generate_invite_code() from public;
revoke all on function public.api_profile_id_by_telegram(text) from public;
revoke all on function public.api_household_id_by_profile(uuid) from public;
revoke all on function public.api_assert_room_create_allowed(uuid) from public;
revoke all on function public.api_assert_plant_create_allowed(uuid) from public;
revoke all on function public.api_assert_ai_photo_request_allowed(uuid) from public;

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
grant execute on function public.api_register_ai_photo_request(text) to anon, authenticated, service_role;
grant execute on function public.api_check_join_invite_rate_limit(text) to anon, authenticated, service_role;
grant execute on function public.api_register_join_invite_failure(text) to anon, authenticated, service_role;
grant execute on function public.api_clear_join_invite_failures(text) to anon, authenticated, service_role;
