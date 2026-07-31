-- Rename character_industry_job_over_time.character_id to registration_id —
-- fourth tranche of step 5 of docs/registration-id-rename.md. Same shape as
-- the character_order rename in #759: table + is_current view + one
-- string-body SQL function that has to be recreated in the same migration,
-- because its body is re-parsed at execution and would otherwise fail at its
-- next call rather than here.
--
-- The wrinkle unique to this family is that the table has a SECOND column with
-- character_id in its name — completed_character_id — and that one is a
-- genuine EVE numeric character id: whoever delivered the job, who need not be
-- a linked character at all. It stays exactly as it is. It is, in fact, one of
-- the few columns in this schema already named correctly under the convention
-- this whole cleanup is establishing, so renaming it would move the schema
-- backwards. Every replacement below is anchored to avoid it.
--
-- Not touched, and not entangled: corp_industry_job_over_time is keyed on
-- corporation_id, and corp_industry_jobs() reaches registration by
-- `id = any(character_ids)` without ever naming this table's column. It carries
-- its own completed_character_id, likewise a real EVE id.
--
-- As in #759 the function's PARAMETER stays character_ids — renaming that is
-- step 7 and has to ship with every RPC call site at once — so the recreated
-- body again reads `where j.registration_id = any(character_ids)`.

alter table public.character_industry_job_over_time rename column character_id to registration_id;

alter index if exists public.character_industry_job_over_time_character_id_idx
  rename to character_industry_job_over_time_registration_id_idx;

drop view if exists public.character_industry_job;
create view public.character_industry_job with (security_invoker = on) as
  select * from public.character_industry_job_over_time where is_current;
grant select on public.character_industry_job to authenticated;

create or replace function public.character_industry_jobs(character_ids uuid[], include_delivered boolean default false, as_of timestamptz default now())
returns json
language sql
stable
as $$
  select coalesce(
    json_agg(
      json_build_object(
        'job_id',                 j.job_id,
        'installer_name',         r.name,
        'activity_id',            j.activity_id,
        'blueprint_id',           j.blueprint_id,
        'blueprint_type_id',      j.blueprint_type_id,
        'blueprint_type_name',    bt.name,
        'blueprint_location_id',  j.blueprint_location_id,
        'output_location_id',     j.output_location_id,
        'station_id',             j.station_id,
        'facility_id',            j.facility_id,
        'runs',                   j.runs,
        'cost',                   j.cost,
        'licensed_runs',          j.licensed_runs,
        'probability',            j.probability,
        'product_type_id',        j.product_type_id,
        'product_type_name',      pt.name,
        'product_quantity',       bp.product_quantity,
        'status',                 j.status,
        'duration',               j.duration,
        'start_date',             j.start_date,
        'end_date',               j.end_date,
        'pause_date',             j.pause_date,
        'completed_date',         j.completed_date,
        'completed_character_id', j.completed_character_id,
        'successful_runs',        j.successful_runs
      )
      order by j.end_date desc
    ),
    '[]'::json
  )
  from public.character_industry_job_over_time j
  join public.registration r on r.id = j.registration_id
  left join public.sde_published_type bt on bt.type_id = j.blueprint_type_id
  left join public.sde_published_type pt on pt.type_id = j.product_type_id
  left join public.sde_blueprint_product bp
    on bp.blueprint_type_id = j.blueprint_type_id
    -- ESI's job activity_id (9 = Reactions) doesn't match the SDE-internal
    -- dogma activity id sde_blueprint_product carries for the same activity
    -- (11); everything else (manufacturing = 1 in both) lines up already.
    and bp.activity_id = case j.activity_id when 9 then 11 else j.activity_id end
    and bp.product_type_id = j.product_type_id
  where j.registration_id = any(character_ids)
    and j.valid_from <= as_of
    and (j.is_current or j.valid_until >= as_of)
    and (include_delivered or j.status not in ('delivered', 'cancelled', 'archived'));
$$;

grant execute on function public.character_industry_jobs(uuid[], boolean, timestamptz) to service_role;

-- Assert the view and the function body, plus — new here — that
-- completed_character_id survived untouched. A rename that swept it up would
-- not fail anywhere: the column would simply vanish from the view and from the
-- Sheets payload's key set, and /api/character/jobs would quietly start
-- emitting a column short.
do $$
declare
  def text;
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_industry_job'
      and column_name = 'character_id'
  ) then
    raise exception 'view character_industry_job still publishes character_id after the rename';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_industry_job'
      and column_name = 'registration_id'
  ) then
    raise exception 'view character_industry_job does not publish registration_id';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'character_industry_job'
      and column_name = 'completed_character_id'
  ) then
    raise exception
      'completed_character_id is missing — it is a real EVE character id and must survive this rename';
  end if;

  select pg_get_functiondef(p.oid) into def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'character_industry_jobs';

  if def is null then
    raise exception 'function public.character_industry_jobs() is missing after the rename';
  end if;
  if def like '%j.character_id%' then
    raise exception
      'character_industry_jobs() body still references j.character_id — it would fail at its next call, not here';
  end if;
  if def not like '%j.registration_id%' then
    raise exception 'character_industry_jobs() body does not reference j.registration_id';
  end if;
  if def not like '%completed_character_id%' then
    raise exception 'character_industry_jobs() body lost completed_character_id';
  end if;
end $$;
