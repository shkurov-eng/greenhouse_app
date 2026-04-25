-- Tasks (bot inbox), AI parsing metadata, and reminder logs.
-- Run in Supabase SQL Editor after multi_household_delete_room.sql.

create extension if not exists pgcrypto;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'open' check (status in ('open', 'done')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_at timestamp with time zone,
  source_platform text,
  source_chat_id bigint,
  source_message_id bigint,
  task_type text,
  assignee_hint text,
  parse_source text not null default 'manual' check (parse_source in ('manual', 'ai')),
  ai_parse_status text not null default 'not_requested' check (
    ai_parse_status in ('not_requested', 'ok', 'low_confidence', 'failed')
  ),
  ai_confidence numeric(4, 3),
  ai_parsed_at timestamp with time zone,
  ai_raw_json jsonb,
  needs_review boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create index if not exists tasks_household_status_created_idx
  on public.tasks (household_id, status, created_at desc);

create index if not exists tasks_due_open_idx
  on public.tasks (due_at)
  where status = 'open';

create unique index if not exists tasks_telegram_message_uidx
  on public.tasks (source_platform, source_chat_id, source_message_id);

create table if not exists public.task_reminders_log (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  reminder_type text not null check (reminder_type in ('due_soon', 'overdue', 'stale_open')),
  sent_to_telegram_id bigint,
  sent_at timestamp with time zone not null default now(),
  payload jsonb
);

create index if not exists task_reminders_log_task_type_sent_idx
  on public.task_reminders_log (task_id, reminder_type, sent_at desc);

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
  v_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

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
    t.parse_source,
    t.ai_parse_status,
    t.ai_confidence,
    t.ai_parsed_at,
    t.needs_review,
    t.created_at,
    t.updated_at
  from public.tasks t
  where t.household_id = v_household_id
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
  p_due_at timestamp with time zone default null
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
  v_priority text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);
  v_priority := lower(coalesce(nullif(btrim(p_priority), ''), 'normal'));

  if v_priority not in ('low', 'normal', 'high') then
    raise exception 'invalid task priority';
  end if;
  if nullif(btrim(p_title), '') is null then
    raise exception 'task title is required';
  end if;

  return query
  insert into public.tasks (
    household_id,
    created_by_profile_id,
    title,
    description,
    priority,
    due_at
  )
  values (
    v_household_id,
    v_profile_id,
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
  v_household_id uuid;
  v_status text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);
  v_status := lower(coalesce(nullif(btrim(p_status), ''), ''));

  if v_status not in ('open', 'done') then
    raise exception 'invalid task status';
  end if;

  update public.tasks t
  set
    status = v_status,
    updated_at = now()
  where t.id = p_task_id
    and t.household_id = v_household_id;

  if not found then
    raise exception 'task not found in household';
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
  v_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  delete from public.tasks t
  where t.id = p_task_id
    and t.household_id = v_household_id;

  if not found then
    raise exception 'task not found in household';
  end if;
end
$$;

alter table public.tasks enable row level security;
alter table public.task_reminders_log enable row level security;
revoke all on table public.tasks from anon, authenticated;
revoke all on table public.task_reminders_log from anon, authenticated;

grant execute on function public.api_list_tasks(text) to anon, authenticated, service_role;
grant execute on function public.api_create_task(text, text, text, text, timestamp with time zone)
  to anon, authenticated, service_role;
grant execute on function public.api_update_task_status(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.api_delete_task(text, uuid) to anon, authenticated, service_role;
