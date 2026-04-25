-- SQL hardening patch for Supabase SQL Editor.
-- Run after the existing migration files have been applied.
-- This consolidates the runtime changes from the SQL RPC Hardening Review.

begin;

create extension if not exists pgcrypto;

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

  if v_require_approval and v_owner_profile_id is null then
    -- Legacy households may predate owner tracking; repair deterministically before approval flow.
    select hm.user_id
    into v_owner_profile_id
    from public.household_members hm
    where hm.household_id = v_target_household_id
    order by hm.user_id
    limit 1;

    if v_owner_profile_id is null then
      raise exception 'household owner is required for approval';
    end if;

    update public.households h
    set created_by_profile_id = v_owner_profile_id
    where h.id = v_target_household_id
      and h.created_by_profile_id is null;
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

create or replace function public.api_is_household_member(
  p_profile_id uuid,
  p_household_id uuid
)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.household_members hm
    where hm.user_id = p_profile_id
      and hm.household_id = p_household_id
  );
$$;

create or replace function public.api_list_tasks(
  p_telegram_id text
)
returns table(
  id uuid,
  household_id uuid,
  title text,
  description text,
  status text,
  priority text,
  due_at timestamp with time zone,
  source_platform text,
  source_chat_id bigint,
  source_message_id bigint,
  task_type text,
  assignee_hint text,
  task_scope text,
  parse_source text,
  ai_parse_status text,
  ai_confidence numeric,
  ai_parsed_at timestamp with time zone,
  needs_review boolean,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
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
    t.id,
    t.household_id,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.due_at,
    t.source_platform,
    t.source_chat_id,
    t.source_message_id,
    t.task_type,
    t.assignee_hint,
    t.task_scope,
    t.parse_source,
    t.ai_parse_status,
    t.ai_confidence,
    t.ai_parsed_at,
    t.needs_review,
    t.created_at,
    t.updated_at
  from public.tasks t
  where
    -- Personal tasks: private to assignee.
    (t.task_scope = 'personal' and t.assignee_profile_id = v_profile_id)
    or
    -- Household tasks: visible in member households.
    (
      t.task_scope = 'household'
      and public.api_is_household_member(v_profile_id, t.household_id)
    )
  order by
    case when t.status = 'open' then 0 else 1 end,
    t.created_at desc;
end
$$;

create or replace function public.api_create_task(
  p_telegram_id text,
  p_title text,
  p_description text default null,
  p_priority text default 'normal',
  p_due_at timestamp with time zone default null,
  p_task_scope text default 'personal',
  p_household_id uuid default null
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_priority text;
  v_scope text;
  v_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_priority := lower(coalesce(nullif(btrim(p_priority), ''), 'normal'));
  v_scope := lower(coalesce(nullif(btrim(p_task_scope), ''), 'personal'));
  v_household_id := p_household_id;

  if v_priority not in ('low', 'normal', 'high') then
    raise exception 'invalid task priority';
  end if;
  if v_scope not in ('personal', 'household') then
    raise exception 'invalid task scope';
  end if;
  if nullif(btrim(p_title), '') is null then
    raise exception 'task title is required';
  end if;

  if v_scope = 'household' then
    if v_household_id is null then
      raise exception 'household_id is required for household task';
    end if;
    if not public.api_is_household_member(v_profile_id, v_household_id) then
      raise exception 'forbidden household target';
    end if;
  else
    v_household_id := null;
  end if;

  return query
  insert into public.tasks (
    household_id,
    created_by_profile_id,
    assignee_profile_id,
    task_scope,
    title,
    description,
    priority,
    due_at
  )
  values (
    v_household_id,
    v_profile_id,
    case when v_scope = 'personal' then v_profile_id else null end,
    v_scope,
    nullif(btrim(p_title), ''),
    nullif(btrim(p_description), ''),
    v_priority,
    p_due_at
  )
  returning tasks.id;
end
$$;

create or replace function public.api_update_task_status(
  p_telegram_id text,
  p_task_id uuid,
  p_status text
)
returns table(id uuid, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_status text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_status := lower(coalesce(nullif(btrim(p_status), ''), ''));

  if v_status not in ('open', 'done') then
    raise exception 'invalid task status';
  end if;

  update public.tasks t
  set
    status = v_status,
    updated_at = now()
  where t.id = p_task_id
    and (
      (t.task_scope = 'personal' and t.assignee_profile_id = v_profile_id)
      or (
        t.task_scope = 'household'
        and public.api_is_household_member(v_profile_id, t.household_id)
      )
    );

  if not found then
    raise exception 'task not found or forbidden';
  end if;

  return query
  select t.id, t.status
  from public.tasks t
  where t.id = p_task_id;
end
$$;

create or replace function public.api_delete_task(
  p_telegram_id text,
  p_task_id uuid
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

  delete from public.tasks t
  where t.id = p_task_id
    and (
      (t.task_scope = 'personal' and t.assignee_profile_id = v_profile_id)
      or (
        t.task_scope = 'household'
        and public.api_is_household_member(v_profile_id, t.household_id)
      )
    );

  if not found then
    raise exception 'task not found or forbidden';
  end if;
end
$$;

do $$
begin
  if to_regprocedure('public.api_generate_invite_code()') is not null then
    execute 'revoke all on function public.api_generate_invite_code() from public';
  end if;
  if to_regprocedure('public.api_profile_id_by_telegram(text)') is not null then
    execute 'revoke all on function public.api_profile_id_by_telegram(text) from public';
  end if;
  if to_regprocedure('public.api_household_id_by_profile(uuid)') is not null then
    execute 'revoke all on function public.api_household_id_by_profile(uuid) from public';
  end if;
  if to_regprocedure('public.api_assert_room_create_allowed(uuid)') is not null then
    execute 'revoke all on function public.api_assert_room_create_allowed(uuid) from public';
  end if;
  if to_regprocedure('public.api_assert_plant_create_allowed(uuid)') is not null then
    execute 'revoke all on function public.api_assert_plant_create_allowed(uuid) from public';
  end if;
  if to_regprocedure('public.api_assert_ai_photo_request_allowed(uuid)') is not null then
    execute 'revoke all on function public.api_assert_ai_photo_request_allowed(uuid) from public';
  end if;
  if to_regprocedure('public.api_assert_household_create_allowed(uuid)') is not null then
    execute 'revoke all on function public.api_assert_household_create_allowed(uuid) from public';
  end if;
end
$$;

revoke all on function public.api_is_household_member(uuid, uuid) from public;

do $$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'public.api_bootstrap_user(text, text)',
    'public.api_join_household(text, text)',
    'public.api_list_rooms(text)',
    'public.api_create_room(text, text)',
    'public.api_room_details(text, uuid)',
    'public.api_create_plant(text, uuid, text, text, text)',
    'public.api_water_plant(text, uuid)',
    'public.api_update_plant(text, uuid, text, text, text)',
    'public.api_upsert_marker(text, uuid, uuid, double precision, double precision)',
    'public.api_prepare_room_image_upload(text, uuid, text)',
    'public.api_attach_room_image(text, uuid, text)',
    'public.api_register_ai_photo_request(text)',
    'public.api_check_join_invite_rate_limit(text)',
    'public.api_register_join_invite_failure(text)',
    'public.api_clear_join_invite_failures(text)',
    'public.api_list_households(text)',
    'public.api_create_household(text, text)',
    'public.api_set_active_household(text, uuid)',
    'public.api_delete_room(text, uuid)',
    'public.api_rename_household(text, uuid, text)',
    'public.api_rename_room(text, uuid, text)',
    'public.api_delete_household(text, uuid)',
    'public.api_get_household_join_settings(text)',
    'public.api_set_household_join_setting(text, uuid, boolean)',
    'public.api_list_household_join_requests(text, uuid)',
    'public.api_review_household_join_request(text, uuid, text)',
    'public.api_list_household_members(text, uuid)',
    'public.api_remove_household_member(text, uuid, uuid)',
    'public.api_list_tasks(text)',
    'public.api_create_task(text, text, text, text, timestamp with time zone, text, uuid)',
    'public.api_update_task_status(text, uuid, text)',
    'public.api_delete_task(text, uuid)',
    'public.api_register_bot_task_ingest(text, text, bigint, bigint)'
  ]
  loop
    if to_regprocedure(function_signature) is not null then
      execute format('grant execute on function %s to anon, authenticated, service_role', function_signature);
    end if;
  end loop;
end
$$;

commit;
