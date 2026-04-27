-- Per-user cartoon room generation limits.
-- Run after security_hardening.sql.

alter table if exists public.profiles
  add column if not exists cartoon_room_limit_enabled boolean not null default true,
  add column if not exists cartoon_room_limit_count integer not null default 3,
  add column if not exists cartoon_room_generated_count integer not null default 0;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_cartoon_room_limit_count_check'
  ) then
    alter table public.profiles
      add constraint profiles_cartoon_room_limit_count_check
      check (cartoon_room_limit_count >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_cartoon_room_generated_count_check'
  ) then
    alter table public.profiles
      add constraint profiles_cartoon_room_generated_count_check
      check (cartoon_room_generated_count >= 0);
  end if;
end
$$;

create or replace function public.api_register_room_cartoon_generation(
  p_telegram_id text
)
returns table(
  limit_enabled boolean,
  limit_count integer,
  used_count integer,
  remaining_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_limit_enabled boolean;
  v_limit_count integer;
  v_used_count integer;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);

  select
    p.cartoon_room_limit_enabled,
    p.cartoon_room_limit_count,
    p.cartoon_room_generated_count
  into
    v_limit_enabled,
    v_limit_count,
    v_used_count
  from public.profiles p
  where p.id = v_profile_id
  for update;

  if v_limit_enabled and v_used_count >= v_limit_count then
    raise exception 'Cartoon room generation limit exceeded (% used of %)', v_used_count, v_limit_count;
  end if;

  update public.profiles p
  set cartoon_room_generated_count = p.cartoon_room_generated_count + 1
  where p.id = v_profile_id;

  return query
  select
    v_limit_enabled,
    v_limit_count,
    v_used_count + 1,
    case
      when v_limit_enabled then greatest(v_limit_count - (v_used_count + 1), 0)
      else null::integer
    end;
end
$$;

grant execute on function public.api_register_room_cartoon_generation(text) to anon, authenticated, service_role;
