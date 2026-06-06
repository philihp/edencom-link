-- /api/industry ImportJSON endpoint: the player's industry jobs across all of
-- their characters, with the owning character's name. Returns the whole result
-- as a single json array (json, not jsonb, to preserve json_build_object's key
-- order for the sheet's columns, and to sidestep PostgREST's max-rows cap).
-- Called with the service role over the caller's own registration ids.
create or replace function public.industry_jobs(character_ids uuid[])
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_location_id',  j.blueprint_location_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'completed_character_id', j.completed_character_id,
        'completed_date',         j.completed_date,
        'cost',                   j.cost,
        'duration',               j.duration,
        'end_date',               j.end_date,
        'facility_id',            j.facility_id,
        'installer_id',           j.installer_id,
        'job_id',                 j.job_id,
        'licensed_runs',          j.licensed_runs,
        'output_location_id',     j.output_location_id,
        'pause_date',             j.pause_date,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'runs',                   j.runs,
        'start_date',             j.start_date,
        'station_id',             j.station_id,
        'status',                 j.status,
        'successful_runs',        j.successful_runs,
        'character_name',         r.name
      )
      order by j.start_date desc
    ),
    '[]'::json
  )
  from public.industry_job j
  join public.registration r on r.id = j.character_id
  where j.character_id = any(character_ids);
$$;

grant execute on function public.industry_jobs(uuid[]) to service_role;
