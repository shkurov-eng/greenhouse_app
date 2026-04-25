-- Store personal tasks independently from households.
-- Run after tasks_scope_and_bot_choice.sql.

alter table if exists public.tasks
  alter column household_id drop not null;

-- Personal tasks are not tied to a household anymore.
update public.tasks
set household_id = null
where task_scope = 'personal';

-- Keep schema consistent: household tasks must have a home, personal tasks must not.
alter table if exists public.tasks
  drop constraint if exists tasks_scope_household_consistency;

alter table if exists public.tasks
  add constraint tasks_scope_household_consistency
  check (
    (task_scope = 'household' and household_id is not null)
    or (task_scope = 'personal' and household_id is null)
  );

drop index if exists tasks_household_status_created_idx;
create index if not exists tasks_household_status_created_idx
  on public.tasks (household_id, status, created_at desc)
  where household_id is not null;

create index if not exists tasks_personal_assignee_status_created_idx
  on public.tasks (assignee_profile_id, status, created_at desc)
  where task_scope = 'personal';

alter table if exists public.bot_task_drafts
  alter column household_id drop not null;

drop function if exists public.api_list_tasks(text);
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
      and exists (
        select 1
        from public.household_members hm
        where hm.household_id = t.household_id
          and hm.user_id = v_profile_id
      )
    )
  order by
    case when t.status = 'open' then 0 else 1 end,
    t.created_at desc;
end
$$;

drop function if exists public.api_create_task(text, text, text, text, timestamp with time zone, text);
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
    if not exists (
      select 1
      from public.household_members hm
      where hm.household_id = v_household_id
        and hm.user_id = v_profile_id
    ) then
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

drop function if exists public.api_update_task_status(text, uuid, text);
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
        and exists (
          select 1
          from public.household_members hm
          where hm.household_id = t.household_id
            and hm.user_id = v_profile_id
        )
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

drop function if exists public.api_delete_task(text, uuid);
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
        and exists (
          select 1
          from public.household_members hm
          where hm.household_id = t.household_id
            and hm.user_id = v_profile_id
        )
      )
    );

  if not found then
    raise exception 'task not found or forbidden';
  end if;
end
$$;

grant execute on function public.api_list_tasks(text) to anon, authenticated, service_role;
grant execute on function public.api_create_task(text, text, text, text, timestamp with time zone, text, uuid)
  to anon, authenticated, service_role;
grant execute on function public.api_update_task_status(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.api_delete_task(text, uuid) to anon, authenticated, service_role;
