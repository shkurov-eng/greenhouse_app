-- Watering reminder settings and send log for household participants.
-- Run after task_overdue_reminder_settings.sql.

alter table if exists public.profiles
  add column if not exists watering_reminders_enabled boolean not null default true,
  add column if not exists watering_reminder_schedule text not null default 'both',
  add column if not exists watering_reminder_morning_hour_utc integer not null default 8,
  add column if not exists watering_reminder_evening_hour_utc integer not null default 19,
  add column if not exists watering_reminder_morning_minute_utc integer,
  add column if not exists watering_reminder_evening_minute_utc integer;

update public.profiles
set
  watering_reminder_morning_minute_utc = coalesce(watering_reminder_morning_minute_utc, watering_reminder_morning_hour_utc * 60),
  watering_reminder_evening_minute_utc = coalesce(watering_reminder_evening_minute_utc, watering_reminder_evening_hour_utc * 60);

alter table if exists public.profiles
  alter column watering_reminder_morning_minute_utc set not null,
  alter column watering_reminder_morning_minute_utc set default 480,
  alter column watering_reminder_evening_minute_utc set not null,
  alter column watering_reminder_evening_minute_utc set default 1140;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_watering_reminder_schedule_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_watering_reminder_schedule_check
      check (watering_reminder_schedule in ('morning', 'evening', 'both'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_watering_reminder_morning_minute_utc_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_watering_reminder_morning_minute_utc_check
      check (watering_reminder_morning_minute_utc between 0 and 1439);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_watering_reminder_evening_minute_utc_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_watering_reminder_evening_minute_utc_check
      check (watering_reminder_evening_minute_utc between 0 and 1439);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_watering_reminder_morning_hour_utc_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_watering_reminder_morning_hour_utc_check
      check (watering_reminder_morning_hour_utc between 0 and 23);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_watering_reminder_evening_hour_utc_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_watering_reminder_evening_hour_utc_check
      check (watering_reminder_evening_hour_utc between 0 and 23);
  end if;
end
$$;

create table if not exists public.plant_watering_reminders_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  slot text not null check (slot in ('morning', 'evening')),
  severity text not null check (severity in ('gentle', 'strict')),
  sent_to_telegram_id bigint not null,
  sent_on date not null default (timezone('utc', now()))::date,
  sent_at timestamp with time zone not null default now(),
  payload jsonb
);

create unique index if not exists plant_watering_reminders_unique_slot_per_day
  on public.plant_watering_reminders_log (household_id, profile_id, slot, sent_on);

create index if not exists plant_watering_reminders_household_sent_idx
  on public.plant_watering_reminders_log (household_id, sent_at desc);

alter table public.plant_watering_reminders_log enable row level security;
revoke all on table public.plant_watering_reminders_log from anon, authenticated;
