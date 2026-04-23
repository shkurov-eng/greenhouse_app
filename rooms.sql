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

drop policy if exists "Rooms bucket public read" on storage.objects;
create policy "Rooms bucket public read"
on storage.objects
for select
to public
using (bucket_id = 'rooms');

drop policy if exists "Rooms bucket public upload" on storage.objects;
create policy "Rooms bucket public upload"
on storage.objects
for insert
to public
with check (bucket_id = 'rooms');

drop policy if exists "Rooms bucket public update" on storage.objects;
create policy "Rooms bucket public update"
on storage.objects
for update
to public
using (bucket_id = 'rooms')
with check (bucket_id = 'rooms');
