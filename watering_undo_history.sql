-- Persistent history for "Undo last watering".
-- Apply this in Supabase SQL Editor.

create table if not exists public.plant_watering_events (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants(id) on delete cascade,
  previous_last_watered_at timestamptz null,
  watered_at timestamptz not null default now(),
  undone_at timestamptz null
);

create index if not exists idx_plant_watering_events_plant_id_watered_at
  on public.plant_watering_events (plant_id, watered_at desc);

create index if not exists idx_plant_watering_events_open_undo
  on public.plant_watering_events (plant_id, watered_at desc)
  where undone_at is null;
