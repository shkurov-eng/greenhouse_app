-- First admin (owner). Run once in Supabase SQL Editor after admin_security.sql.
-- Idempotent: safe to re-run. To use another email, change the value below.

insert into public.admin_users (email, role, is_active)
values (lower(trim('shkurov@gmail.com')), 'owner', true)
on conflict (email) do update
set
  role = excluded.role,
  is_active = excluded.is_active,
  updated_at = now();
