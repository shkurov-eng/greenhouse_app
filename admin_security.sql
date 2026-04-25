-- Admin and security control layer
-- Safe to run multiple times in development.

create extension if not exists pgcrypto;

create table if not exists public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null default 'readonly' check (role in ('owner', 'security', 'support', 'readonly')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_admin_users_active on public.admin_users (is_active, role);

create table if not exists public.profile_blocks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid null references public.profiles(id) on delete cascade,
  telegram_id bigint null,
  block_type text not null default 'temporary' check (block_type in ('temporary', 'permanent')),
  scope text not null default 'global',
  reason text not null,
  note text null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz null,
  is_active boolean not null default true,
  created_by_admin_id uuid null references public.admin_users(id) on delete set null,
  revoked_by_admin_id uuid null references public.admin_users(id) on delete set null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (profile_id is not null or telegram_id is not null),
  check (
    (block_type = 'permanent' and ends_at is null)
    or (block_type = 'temporary' and ends_at is not null)
  )
);

create index if not exists idx_profile_blocks_profile_active
  on public.profile_blocks (profile_id, is_active, starts_at desc);
create index if not exists idx_profile_blocks_telegram_active
  on public.profile_blocks (telegram_id, is_active, starts_at desc);
create index if not exists idx_profile_blocks_window
  on public.profile_blocks (starts_at, ends_at);

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_user_id uuid null references public.admin_users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'critical')),
  details jsonb not null default '{}'::jsonb,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_created on public.admin_audit_log (created_at desc);
create index if not exists idx_admin_audit_log_action on public.admin_audit_log (action, created_at desc);

create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  severity text not null default 'warning' check (severity in ('info', 'warning', 'critical')),
  source text not null,
  telegram_id bigint null,
  profile_id uuid null references public.profiles(id) on delete set null,
  endpoint text null,
  action text null,
  details jsonb not null default '{}'::jsonb,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_security_events_created on public.security_events (created_at desc);
create index if not exists idx_security_events_type on public.security_events (event_type, created_at desc);
create index if not exists idx_security_events_profile on public.security_events (profile_id, created_at desc);

create table if not exists public.api_request_events (
  id bigint generated always as identity primary key,
  source text not null,
  endpoint text not null,
  action text null,
  method text not null,
  status_code integer not null,
  duration_ms integer not null,
  telegram_id bigint null,
  profile_id uuid null references public.profiles(id) on delete set null,
  is_blocked boolean not null default false,
  is_error boolean not null default false,
  error_message text null,
  ip_hash text null,
  user_agent_hash text null,
  created_at timestamptz not null default now()
);

create index if not exists idx_api_request_events_created on public.api_request_events (created_at desc);
create index if not exists idx_api_request_events_endpoint on public.api_request_events (endpoint, created_at desc);
create index if not exists idx_api_request_events_source on public.api_request_events (source, created_at desc);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_admin_users_updated_at on public.admin_users;
create trigger trg_admin_users_updated_at
before update on public.admin_users
for each row execute function public.set_updated_at_timestamp();

drop trigger if exists trg_profile_blocks_updated_at on public.profile_blocks;
create trigger trg_profile_blocks_updated_at
before update on public.profile_blocks
for each row execute function public.set_updated_at_timestamp();

create or replace function public.api_is_profile_blocked(
  p_telegram_id text
)
returns table (
  is_blocked boolean,
  block_id uuid,
  block_type text,
  reason text,
  ends_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with profile_row as (
    select id, telegram_id
    from public.profiles
    where telegram_id = nullif(trim(p_telegram_id), '')::bigint
    limit 1
  )
  select
    true as is_blocked,
    b.id as block_id,
    b.block_type,
    b.reason,
    b.ends_at
  from public.profile_blocks b
  left join profile_row p on true
  where b.is_active = true
    and b.starts_at <= now()
    and (b.ends_at is null or b.ends_at > now())
    and (
      (p.id is not null and b.profile_id = p.id)
      or (p.telegram_id is not null and b.telegram_id = p.telegram_id)
    )
  order by b.created_at desc
  limit 1;
$$;

create or replace view public.admin_overview_24h as
with since as (
  select now() - interval '24 hours' as ts
)
select
  (select count(*) from public.profiles p, since s where p.created_at >= s.ts) as users_new_24h,
  (select count(distinct are.telegram_id) from public.api_request_events are, since s where are.created_at >= s.ts and are.telegram_id is not null) as users_active_24h,
  (select count(distinct hm.household_id)
   from public.household_members hm
   join public.profiles p on p.id = hm.user_id
   join public.api_request_events are on are.profile_id = p.id, since s
   where are.created_at >= s.ts) as households_active_24h,
  (select count(*) from public.security_events se, since s where se.created_at >= s.ts) as security_events_24h,
  (select count(*) from public.security_events se, since s where se.created_at >= s.ts and se.severity = 'critical') as critical_events_24h,
  (select count(*) from public.profile_blocks b where b.is_active = true and b.starts_at <= now() and (b.ends_at is null or b.ends_at > now())) as active_blocks_now,
  (select coalesce(avg(are.duration_ms), 0)::numeric(10,2) from public.api_request_events are, since s where are.created_at >= s.ts) as avg_request_ms_24h;

create or replace view public.admin_top_users_24h as
with since as (
  select now() - interval '24 hours' as ts
)
select
  p.id as profile_id,
  p.telegram_id,
  p.username,
  count(*)::int as request_count,
  count(*) filter (where are.is_error)::int as error_count
from public.api_request_events are
join public.profiles p on p.telegram_id = are.telegram_id
join since s on true
where are.created_at >= s.ts
group by p.id, p.telegram_id, p.username
order by request_count desc
limit 20;

create or replace function public.admin_record_security_event(
  p_event_type text,
  p_severity text,
  p_source text,
  p_telegram_id bigint,
  p_profile_id uuid,
  p_endpoint text,
  p_action text,
  p_details jsonb,
  p_ip_hash text,
  p_user_agent_hash text
)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.security_events (
    event_type, severity, source, telegram_id, profile_id, endpoint, action, details, ip_hash, user_agent_hash
  )
  values (
    coalesce(nullif(trim(p_event_type), ''), 'unknown_event'),
    case when p_severity in ('info', 'warning', 'critical') then p_severity else 'warning' end,
    coalesce(nullif(trim(p_source), ''), 'unknown_source'),
    p_telegram_id,
    p_profile_id,
    nullif(trim(coalesce(p_endpoint, '')), ''),
    nullif(trim(coalesce(p_action, '')), ''),
    coalesce(p_details, '{}'::jsonb),
    nullif(trim(coalesce(p_ip_hash, '')), ''),
    nullif(trim(coalesce(p_user_agent_hash, '')), '')
  )
  returning id;
$$;

revoke all on table public.admin_users from anon, authenticated;
revoke all on table public.profile_blocks from anon, authenticated;
revoke all on table public.admin_audit_log from anon, authenticated;
revoke all on table public.security_events from anon, authenticated;
revoke all on table public.api_request_events from anon, authenticated;

revoke all on function public.api_is_profile_blocked(text) from public;
revoke all on function public.admin_record_security_event(
  text, text, text, bigint, uuid, text, text, jsonb, text, text
) from public;

grant execute on function public.api_is_profile_blocked(text) to service_role;
grant execute on function public.admin_record_security_event(
  text, text, text, bigint, uuid, text, text, jsonb, text, text
) to service_role;
