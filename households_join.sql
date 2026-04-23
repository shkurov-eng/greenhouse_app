alter table public.households
  add column if not exists invite_code text;

create unique index if not exists households_invite_code_unique_idx
  on public.households (invite_code);
