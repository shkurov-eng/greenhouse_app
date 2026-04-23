create table if not exists public.plants (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  name text not null,
  species text,
  status text not null default 'healthy' check (status in ('healthy', 'thirsty', 'overdue')),
  last_watered_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

alter table public.plants
  add column if not exists status text not null default 'healthy'
  check (status in ('healthy', 'thirsty', 'overdue'));

alter table public.plants
  add column if not exists last_watered_at timestamp with time zone;

update public.plants
set status = 'healthy'
where status is null;

update public.plants
set last_watered_at = created_at
where last_watered_at is null and status = 'healthy';

create table if not exists public.plant_markers (
  id uuid primary key default gen_random_uuid(),
  plant_id uuid not null references public.plants(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  x double precision not null check (x >= 0 and x <= 1),
  y double precision not null check (y >= 0 and y <= 1),
  created_at timestamp with time zone default now()
);

create unique index if not exists plant_markers_plant_id_unique_idx
  on public.plant_markers (plant_id);

create index if not exists plant_markers_room_id_idx
  on public.plant_markers (room_id);
