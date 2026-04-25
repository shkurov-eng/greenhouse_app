-- Run after multi_household_delete_room.sql.
-- Adds owner approval flow for household join by invite code.

alter table if exists public.households
  add column if not exists created_by_profile_id uuid references public.profiles(id) on delete set null;

alter table if exists public.households
  add column if not exists require_join_approval boolean not null default true;

alter table if exists public.households
  alter column require_join_approval set default true;

update public.households
set require_join_approval = true
where require_join_approval = false;

update public.households h
set created_by_profile_id = sub.user_id
from (
  select distinct on (hm.household_id) hm.household_id, hm.user_id
  from public.household_members hm
  order by hm.household_id, hm.user_id
) sub
where h.id = sub.household_id
  and h.created_by_profile_id is null;

create table if not exists public.household_create_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('manual_create', 'bootstrap_fallback')),
  created_at timestamp with time zone not null default now()
);

create index if not exists household_create_events_profile_created_idx
  on public.household_create_events (profile_id, created_at desc);

alter table public.household_create_events enable row level security;
revoke all on table public.household_create_events from anon, authenticated;

create or replace function public.api_assert_household_create_allowed(
  p_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour_limit integer := 3;
  v_day_limit integer := 10;
  v_hour_count integer;
  v_day_count integer;
begin
  if p_profile_id is null then
    raise exception 'profile id is required';
  end if;

  select count(*)
  into v_hour_count
  from public.household_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '1 hour';

  if v_hour_count >= v_hour_limit then
    raise exception 'household creation rate limit exceeded (hourly)';
  end if;

  select count(*)
  into v_day_count
  from public.household_create_events e
  where e.profile_id = p_profile_id
    and e.created_at >= now() - interval '24 hours';

  if v_day_count >= v_day_limit then
    raise exception 'household creation rate limit exceeded (daily)';
  end if;
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
    perform public.api_assert_household_create_allowed(v_profile_id);

    loop
      v_invite_code := public.api_generate_invite_code();
      begin
        insert into public.households (name, invite_code, created_by_profile_id, require_join_approval)
        values ('My Home', v_invite_code, v_profile_id, true)
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

    insert into public.household_create_events (profile_id, reason)
    values (v_profile_id, 'bootstrap_fallback');
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

  perform public.api_assert_household_create_allowed(v_profile_id);

  loop
    v_invite_code := public.api_generate_invite_code();
    begin
      insert into public.households (name, invite_code, created_by_profile_id, require_join_approval)
      values (v_name, v_invite_code, v_profile_id, true)
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

  insert into public.household_create_events (profile_id, reason)
  values (v_profile_id, 'manual_create');

  update public.profiles
  set active_household_id = v_household_id
  where id = v_profile_id;

  return query
  select h.id, h.name, h.invite_code
  from public.households h
  where h.id = v_household_id;
end
$$;

create table if not exists public.household_join_requests (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  requester_telegram_id bigint not null,
  requester_username text,
  invite_code text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by_profile_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create unique index if not exists household_join_requests_pending_uidx
  on public.household_join_requests (household_id, requester_profile_id)
  where status = 'pending';

create index if not exists household_join_requests_household_status_idx
  on public.household_join_requests (household_id, status, created_at desc);

alter table public.household_join_requests enable row level security;
revoke all on table public.household_join_requests from anon, authenticated;

drop function if exists public.api_join_household(text, text);

create or replace function public.api_join_household(
  p_telegram_id text,
  p_invite_code text
)
returns table(
  join_status text,
  household_id uuid,
  household_name text,
  invite_code text,
  request_id uuid,
  owner_telegram_id bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_target_household_id uuid;
  v_target_household_name text;
  v_target_invite_code text;
  v_owner_profile_id uuid;
  v_require_approval boolean;
  v_request_id uuid;
  v_username text;
  v_owner_telegram_id bigint;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select h.id, h.name, h.invite_code, h.created_by_profile_id, coalesce(h.require_join_approval, false)
  into v_target_household_id, v_target_household_name, v_target_invite_code, v_owner_profile_id, v_require_approval
  from public.households h
  where h.invite_code = upper(btrim(p_invite_code))
  limit 1;

  if v_target_household_id is null then
    raise exception 'invite code not found';
  end if;

  if exists (
    select 1
    from public.household_members hm
    where hm.household_id = v_target_household_id
      and hm.user_id = v_profile_id
  ) then
    return query
    select 'already_member'::text, v_target_household_id, v_target_household_name, v_target_invite_code, null::uuid, null::bigint;
    return;
  end if;

  if v_require_approval and v_owner_profile_id is not null and v_owner_profile_id <> v_profile_id then
    select p.telegram_id
    into v_owner_telegram_id
    from public.profiles p
    where p.id = v_owner_profile_id;

    select p.username
    into v_username
    from public.profiles p
    where p.id = v_profile_id;

    execute
      'insert into public.household_join_requests (
         household_id,
         requester_profile_id,
         requester_telegram_id,
         requester_username,
         invite_code,
         status,
         updated_at
       )
       values ($1, $2, $3, $4, $5, ''pending'', now())
       on conflict (household_id, requester_profile_id)
       where status = ''pending''
       do update set
         invite_code = excluded.invite_code,
         requester_username = excluded.requester_username,
         requester_telegram_id = excluded.requester_telegram_id,
         updated_at = now()
       returning id'
    into v_request_id
    using v_target_household_id, v_profile_id, p_telegram_id::bigint, v_username, v_target_invite_code;

    return query
    select 'pending_approval'::text, v_target_household_id, v_target_household_name, v_target_invite_code, v_request_id, v_owner_telegram_id;
    return;
  end if;

  execute
    'insert into public.household_members (household_id, user_id) values ($1, $2)
     on conflict (household_id, user_id) do nothing'
    using v_target_household_id, v_profile_id;

  update public.profiles
  set active_household_id = v_target_household_id
  where id = v_profile_id;

  return query
  select 'joined'::text, v_target_household_id, v_target_household_name, v_target_invite_code, null::uuid, null::bigint;
end
$$;

create or replace function public.api_get_household_join_settings(
  p_telegram_id text
)
returns table(
  household_id uuid,
  household_name text,
  require_join_approval boolean,
  is_owner boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  return query
  select
    h.id,
    h.name,
    coalesce(h.require_join_approval, false),
    (h.created_by_profile_id = v_profile_id) as is_owner
  from public.households h
  inner join public.household_members hm on hm.household_id = h.id
  where hm.user_id = v_profile_id
  order by h.name asc;
end
$$;

create or replace function public.api_set_household_join_setting(
  p_telegram_id text,
  p_household_id uuid,
  p_require_join_approval boolean
)
returns table(
  household_id uuid,
  household_name text,
  require_join_approval boolean,
  is_owner boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  if not exists (
    select 1
    from public.households h
    where h.id = p_household_id
      and h.created_by_profile_id = v_profile_id
  ) then
    raise exception 'only household owner can change join approval setting';
  end if;

  update public.households h
  set require_join_approval = p_require_join_approval
  where h.id = p_household_id;

  return query
  select h.id, h.name, coalesce(h.require_join_approval, false), true
  from public.households h
  where h.id = p_household_id;
end
$$;

create or replace function public.api_list_household_join_requests(
  p_telegram_id text,
  p_household_id uuid
)
returns table(
  request_id uuid,
  household_id uuid,
  household_name text,
  requester_profile_id uuid,
  requester_telegram_id bigint,
  requester_username text,
  invite_code text,
  status text,
  created_at timestamp with time zone
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  if not exists (
    select 1
    from public.households h
    where h.id = p_household_id
      and h.created_by_profile_id = v_profile_id
  ) then
    raise exception 'only household owner can view join requests';
  end if;

  return query
  select
    r.id,
    h.id,
    h.name,
    r.requester_profile_id,
    r.requester_telegram_id,
    r.requester_username,
    r.invite_code,
    r.status,
    r.created_at
  from public.household_join_requests r
  inner join public.households h on h.id = r.household_id
  where r.household_id = p_household_id
    and r.status = 'pending'
  order by r.created_at desc;
end
$$;

create or replace function public.api_review_household_join_request(
  p_telegram_id text,
  p_request_id uuid,
  p_decision text
)
returns table(
  join_status text,
  household_id uuid,
  household_name text,
  requester_telegram_id bigint,
  requester_username text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_decision text;
  v_request public.household_join_requests%rowtype;
  v_household_name text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_decision := lower(coalesce(nullif(btrim(p_decision), ''), ''));

  if v_decision not in ('approve', 'reject') then
    raise exception 'invalid decision';
  end if;

  select *
  into v_request
  from public.household_join_requests r
  where r.id = p_request_id
  for update;

  if not found then
    raise exception 'join request not found';
  end if;

  select h.name
  into v_household_name
  from public.households h
  where h.id = v_request.household_id
    and h.created_by_profile_id = v_profile_id;

  if v_household_name is null then
    raise exception 'only household owner can review join requests';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'join request already reviewed';
  end if;

  if v_decision = 'approve' then
    execute
      'insert into public.household_members (household_id, user_id) values ($1, $2)
       on conflict (household_id, user_id) do nothing'
      using v_request.household_id, v_request.requester_profile_id;

    update public.profiles
    set active_household_id = v_request.household_id
    where id = v_request.requester_profile_id
      and active_household_id is null;

    update public.household_join_requests
    set status = 'approved',
        reviewed_by_profile_id = v_profile_id,
        reviewed_at = now(),
        updated_at = now()
    where id = v_request.id;

    return query
    select 'approved'::text, v_request.household_id, v_household_name, v_request.requester_telegram_id, v_request.requester_username;
    return;
  end if;

  update public.household_join_requests
  set status = 'rejected',
      reviewed_by_profile_id = v_profile_id,
      reviewed_at = now(),
      updated_at = now()
  where id = v_request.id;

  return query
  select 'rejected'::text, v_request.household_id, v_household_name, v_request.requester_telegram_id, v_request.requester_username;
end
$$;

create or replace function public.api_list_household_members(
  p_telegram_id text,
  p_household_id uuid
)
returns table(
  household_id uuid,
  household_name text,
  profile_id uuid,
  telegram_id bigint,
  username text,
  is_owner boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  if not exists (
    select 1
    from public.households h
    where h.id = p_household_id
      and h.created_by_profile_id = v_profile_id
  ) then
    raise exception 'only household owner can view members';
  end if;

  return query
  select
    h.id,
    h.name,
    p.id,
    p.telegram_id,
    p.username,
    (p.id = h.created_by_profile_id) as is_owner
  from public.household_members hm
  inner join public.households h on h.id = hm.household_id
  inner join public.profiles p on p.id = hm.user_id
  where hm.household_id = p_household_id
  order by
    case when p.id = h.created_by_profile_id then 0 else 1 end,
    p.username asc nulls last,
    p.telegram_id asc;
end
$$;

create or replace function public.api_remove_household_member(
  p_telegram_id text,
  p_household_id uuid,
  p_member_profile_id uuid
)
returns table(
  household_id uuid,
  household_name text,
  removed_profile_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_profile_id uuid;
  v_household_name text;
begin
  v_owner_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select h.name
  into v_household_name
  from public.households h
  where h.id = p_household_id
    and h.created_by_profile_id = v_owner_profile_id;

  if v_household_name is null then
    raise exception 'only household owner can remove members';
  end if;

  if p_member_profile_id = v_owner_profile_id then
    raise exception 'owner cannot remove themselves';
  end if;

  delete from public.household_members hm
  where hm.household_id = p_household_id
    and hm.user_id = p_member_profile_id;

  if not found then
    raise exception 'member not found in household';
  end if;

  update public.profiles p
  set active_household_id = null
  where p.id = p_member_profile_id
    and p.active_household_id = p_household_id;

  return query
  select p_household_id, v_household_name, p_member_profile_id;
end
$$;

grant execute on function public.api_join_household(text, text) to anon, authenticated, service_role;
grant execute on function public.api_get_household_join_settings(text) to anon, authenticated, service_role;
grant execute on function public.api_set_household_join_setting(text, uuid, boolean) to anon, authenticated, service_role;
grant execute on function public.api_list_household_join_requests(text, uuid) to anon, authenticated, service_role;
grant execute on function public.api_review_household_join_request(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.api_list_household_members(text, uuid) to anon, authenticated, service_role;
grant execute on function public.api_remove_household_member(text, uuid, uuid) to anon, authenticated, service_role;
