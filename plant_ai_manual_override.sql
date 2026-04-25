-- Manual plant edits should clear AI inference badge.
-- After user changes plant fields in Edit Plant, we treat data as user-authored.

create or replace function public.api_update_plant(
  p_telegram_id text,
  p_plant_id uuid,
  p_name text,
  p_species text,
  p_status text,
  p_thirsty_after_minutes integer default 5,
  p_overdue_after_minutes integer default 60
)
returns table(id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid;
  v_household_id uuid;
begin
  v_profile_id := public.api_profile_id_by_telegram(p_telegram_id);
  v_household_id := public.api_household_id_by_profile(v_profile_id);

  if p_status not in ('healthy', 'thirsty', 'overdue') then
    raise exception 'invalid plant status';
  end if;
  if p_thirsty_after_minutes is null or p_thirsty_after_minutes <= 0 then
    raise exception 'invalid thirsty threshold';
  end if;
  if p_overdue_after_minutes is null or p_overdue_after_minutes <= 0 then
    raise exception 'invalid overdue threshold';
  end if;
  if p_overdue_after_minutes < p_thirsty_after_minutes then
    raise exception 'invalid watering thresholds';
  end if;

  update public.plants p
  set name = nullif(btrim(p_name), ''),
      species = nullif(btrim(p_species), ''),
      status = p_status,
      thirsty_after_minutes = p_thirsty_after_minutes,
      overdue_after_minutes = p_overdue_after_minutes,
      ai_inferred_at = null
  where p.id = p_plant_id
    and p.household_id = v_household_id;

  if not found then
    raise exception 'plant not found in household';
  end if;

  return query select p_plant_id;
end
$$;

grant execute on function public.api_update_plant(text, uuid, text, text, text, integer, integer)
  to anon, authenticated, service_role;
