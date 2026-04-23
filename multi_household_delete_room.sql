-- Run in Supabase SQL Editor after security_hardening.sql.
-- Multi-household membership, active home on profile, delete room RPC, join without leaving old homes.

alter table if exists public.profiles
  add column if not exists active_household_id uuid references public.households(id) on delete set null;

-- Drop legacy "one household per user" unique constraint / index (Supabase scaffolds vary by name).
alter table if exists public.household_members
  drop constraint if exists household_members_user_id_key;

alter table if exists public.household_members
  drop constraint if exists household_members_user_id_unique;

-- If uniqueness was created only as a unique index (no table constraint), remove it too.
drop index if exists public.household_members_user_id_unique;

create unique index if not exists household_members_household_user_uidx
  on public.household_members (household_id, user_id);

-- Backfill active home from any existing membership.
update public.profiles p
set active_household_id = sub.household_id
from (
  select distinct on (hm.user_id) hm.user_id, hm.household_id
  from public.household_members hm
  order by hm.user_id, hm.household_id
) sub
where p.id = sub.user_id
  and (p.active_household_id is null or p.active_household_id not in (
    select hm2.household_id from public.household_members hm2 where hm2.user_id = p.id
  ));

create or replace function public.api_household_id_by_profile(p_profile_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_active uuid;
  v_household_id uuid;
begin
  select p.active_household_id
  into v_active
  from public.profiles p
  where p.id = p_profile_id;

  if v_active is not null then
    if exists (
      select 1
      from public.household_members hm
      where hm.user_id = p_profile_id
        and hm.household_id = v_active
    ) then
      return v_active;
    end if;
  end if;

  select hm.household_id
  into v_household_id
  from public.household_members hm
  where hm.user_id = p_profile_id
  order by hm.household_id
  limit 1;

  if v_household_id is null then
    raise exception 'user is not linked to a household';
  end if;

  update public.profiles
  set active_household_id = v_household_id
  where id = p_profile_id
    and (active_household_id is distinct from v_household_id);

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
  order by hm.household_id
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
          null;
      end;
    end loop;

    -- EXECUTE avoids PL/pgSQL OUT column name "household_id" shadowing table columns in ON CONFLICT.
    execute
      'insert into public.household_members (household_id, user_id) values ($1, $2)
       on conflict (household_id, user_id) do nothing'
      using v_household_id, v_profile_id;
  end if;

  v_household_id := public.api_household_id_by_profile(v_profile_id);

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

  execute
    'insert into public.household_members (household_id, user_id) values ($1, $2)
     on conflict (household_id, user_id) do nothing'
    using v_target_household_id, v_profile_id;

  update public.profiles
  set active_household_id = v_target_household_id
  where id = v_profile_id;

  return query
  select h.id, h.name, h.invite_code
  from public.households h
  where h.id = v_target_household_id;
end
$$;

create or replace function public.api_list_households(p_telegram_id text)
returns table(household_id uuid, household_name text, invite_code text, is_active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_active uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select p.active_household_id into v_active
  from public.profiles p
  where p.id = v_profile_id;

  if v_active is null or not exists (
    select 1 from public.household_members hm
    where hm.user_id = v_profile_id and hm.household_id = v_active
  ) then
    v_active := public.api_household_id_by_profile(v_profile_id);
  end if;

  return query
  select
    h.id,
    h.name,
    h.invite_code,
    (h.id = v_active) as is_active
  from public.households h
  inner join public.household_members hm on hm.household_id = h.id
  where hm.user_id = v_profile_id
  order by h.name asc;
end
$$;

create or replace function public.api_create_household(
  p_telegram_id text,
  p_name text default null
)
returns table(household_id uuid, household_name text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_invite_code text;
  v_name text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_name := coalesce(nullif(btrim(p_name), ''), 'New Home');

  loop
    v_invite_code := public.api_generate_invite_code();
    begin
      insert into public.households (name, invite_code)
      values (v_name, v_invite_code)
      returning id into v_household_id;
      exit;
    exception
      when unique_violation then
        null;
    end;
  end loop;

  execute
    'insert into public.household_members (household_id, user_id) values ($1, $2)
     on conflict (household_id, user_id) do nothing'
    using v_household_id, v_profile_id;

  update public.profiles
  set active_household_id = v_household_id
  where id = v_profile_id;

  return query
  select h.id, h.name, h.invite_code
  from public.households h
  where h.id = v_household_id;
end
$$;

create or replace function public.api_set_active_household(
  p_telegram_id text,
  p_household_id uuid
)
returns table(household_id uuid, household_name text, invite_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  if not exists (
    select 1 from public.household_members hm
    where hm.user_id = v_profile_id and hm.household_id = p_household_id
  ) then
    raise exception 'not a member of this household';
  end if;

  update public.profiles
  set active_household_id = p_household_id
  where id = v_profile_id;

  return query
  select h.id, h.name, h.invite_code
  from public.households h
  where h.id = p_household_id;
end
$$;

create or replace function public.api_delete_room(
  p_telegram_id text,
  p_room_id uuid
)
returns void
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

  delete from public.rooms r
  where r.id = p_room_id
    and r.household_id = v_household_id;

  if not found then
    raise exception 'room not found or forbidden';
  end if;
end
$$;

grant execute on function public.api_list_households(text) to anon, authenticated, service_role;
grant execute on function public.api_create_household(text, text) to anon, authenticated, service_role;
grant execute on function public.api_set_active_household(text, uuid) to anon, authenticated, service_role;
grant execute on function public.api_delete_room(text, uuid) to anon, authenticated, service_role;

-- Delete a household the caller belongs to (all members lose access; rooms/plants cascade).
create or replace function public.api_delete_household(
  p_telegram_id text,
  p_household_id uuid
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

  if not exists (
    select 1 from public.household_members hm
    where hm.user_id = v_profile_id and hm.household_id = p_household_id
  ) then
    raise exception 'not a member of this household';
  end if;

  begin
    execute 'delete from public.tasks where household_id = $1' using p_household_id;
  exception
    when undefined_table then
      null;
  end;

  delete from public.household_members hm
  where hm.household_id = p_household_id;

  delete from public.households h
  where h.id = p_household_id;

  if not found then
    raise exception 'household not found';
  end if;
end
$$;

grant execute on function public.api_delete_household(text, uuid) to anon, authenticated, service_role;
