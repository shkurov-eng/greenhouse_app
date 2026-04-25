-- Per-user mode for how bot messages are converted into tasks.
-- Run after multi_household_delete_room.sql.

alter table if exists public.profiles
  add column if not exists task_message_mode text not null default 'single'
    check (task_message_mode in ('single', 'combine'));
