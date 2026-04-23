create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  background_url text,
  created_at timestamp with time zone default now()
);

create index if not exists rooms_household_id_idx
  on public.rooms (household_id);

insert into storage.buckets (id, name, public)
values ('rooms', 'rooms', true)
on conflict (id) do nothing;
