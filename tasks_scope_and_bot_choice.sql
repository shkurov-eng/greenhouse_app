-- Task visibility scopes and Telegram bot "personal vs household" choice flow.
-- Run after tasks_bot_reminders.sql.

alter table if exists public.tasks
  add column if not exists task_scope text not null default 'household'
    check (task_scope in ('personal', 'household'));

alter table if exists public.tasks
  add column if not exists assignee_profile_id uuid references public.profiles(id) on delete set null;

create index if not exists tasks_scope_assignee_idx
  on public.tasks (task_scope, assignee_profile_id);

create table if not exists public.bot_task_drafts (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'telegram',
  source_chat_id bigint not null,
  source_message_id bigint not null,
  created_by_telegram_id bigint not null,
  created_by_profile_id uuid not null references public.profiles(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  raw_text text not null,
  normalized_title text not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  due_at timestamp with time zone,
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
  selected_scope text check (selected_scope in ('personal', 'household')),
  consumed_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.bot_task_ingest_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  source_platform text not null default 'telegram',
  source_chat_id bigint,
  source_message_id bigint,
  created_at timestamp with time zone not null default now()
);

create index if not exists bot_task_ingest_events_profile_created_idx
  on public.bot_task_ingest_events (profile_id, created_at desc);

alter table if exists public.bot_task_drafts
  add column if not exists selected_scope text
    check (selected_scope in ('personal', 'household'));

create unique index if not exists bot_task_drafts_source_uidx
  on public.bot_task_drafts (source_platform, source_chat_id, source_message_id);

alter table public.bot_task_drafts enable row level security;
revoke all on table public.bot_task_drafts from anon, authenticated;
alter table public.bot_task_ingest_events enable row level security;
revoke all on table public.bot_task_ingest_events from anon, authenticated;

create or replace function public.api_register_bot_task_ingest(
  p_telegram_id text,
  p_source_platform text default 'telegram',
  p_source_chat_id bigint default null,
  p_source_message_id bigint default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_hour_limit integer := 40;
  v_day_limit integer := 200;
  v_hour_count integer;
  v_day_count integer;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select count(*)
  into v_hour_count
  from public.bot_task_ingest_events e
  where e.profile_id = v_profile_id
    and e.created_at >= now() - interval '1 hour';

  if v_hour_count >= v_hour_limit then
    raise exception 'bot task ingest rate limit exceeded (hourly)';
  end if;

  select count(*)
  into v_day_count
  from public.bot_task_ingest_events e
  where e.profile_id = v_profile_id
    and e.created_at >= now() - interval '24 hours';

  if v_day_count >= v_day_limit then
    raise exception 'bot task ingest rate limit exceeded (daily)';
  end if;

  insert into public.bot_task_ingest_events (
    profile_id,
    source_platform,
    source_chat_id,
    source_message_id
  )
  values (
    v_profile_id,
    coalesce(nullif(btrim(p_source_platform), ''), 'telegram'),
    p_source_chat_id,
    p_source_message_id
  );
end
$$;

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
    t.task_scope,
    t.parse_source,
    t.ai_parse_status,
    t.ai_confidence,
    t.ai_parsed_at,
    t.needs_review,
    t.created_at,
    t.updated_at
  from public.tasks t
  where t.household_id = v_household_id
    and (
      t.task_scope = 'household'
      or (t.task_scope = 'personal' and t.assignee_profile_id = v_profile_id)
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
  p_task_scope text default 'personal'
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
  v_scope text;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);
  v_priority := lower(coalesce(nullif(btrim(p_priority), ''), 'normal'));
  v_scope := lower(coalesce(nullif(btrim(p_task_scope), ''), 'personal'));

  if v_priority not in ('low', 'normal', 'high') then
    raise exception 'invalid task priority';
  end if;
  if v_scope not in ('personal', 'household') then
    raise exception 'invalid task scope';
  end if;
  if nullif(btrim(p_title), '') is null then
    raise exception 'task title is required';
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

grant execute on function public.api_create_task(text, text, text, text, timestamp with time zone, text)
  to anon, authenticated, service_role;
grant execute on function public.api_register_bot_task_ingest(text, text, bigint, bigint)
  to anon, authenticated, service_role;
