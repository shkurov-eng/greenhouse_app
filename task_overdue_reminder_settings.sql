-- Per-user setting: allow/disallow repeated overdue reminders.
-- Run after task_message_mode_settings.sql.

alter table if exists public.profiles
  add column if not exists repeat_overdue_reminders boolean not null default true;
