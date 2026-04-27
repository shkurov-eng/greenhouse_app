-- Track which profile performed each watering event.
-- Apply this in Supabase SQL Editor.

alter table if exists public.plant_watering_events
  add column if not exists watered_by_profile_id uuid references public.profiles(id) on delete set null;

create index if not exists idx_plant_watering_events_watered_by_profile
  on public.plant_watering_events (watered_by_profile_id);
