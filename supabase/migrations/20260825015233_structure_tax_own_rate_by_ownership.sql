-- structure_tax_revenue(): decide the own-rate subset by OWNERSHIP, not by
-- matching the installing corporation against the owning one.
--
-- The previous reading asked whether the corporation that installed a job was
-- the same corporation that owns the structure. That is the wrong question, and
-- it silently zeroed the figure it exists to report.
--
-- Facility tax is levied on the JOB. A job we initiated, run in a structure we
-- own, is billed at our own rate and the ISK never leaves the group — it makes
-- no difference whether a character installed it or a corporation did, nor
-- which of our corporations owns the structure it ran in. Characters commonly
-- sit in one corporation while the structures belong to another; under the old
-- test every one of those jobs was reported as though a stranger had billed us,
-- and the whole saving vanished.
--
-- So the test is now: is the job ours, and does one of OUR corporations own the
-- structure. `my_corporation_ids()` answers the second half — the corporations
-- the caller has a character in — and the two job views answer the first, both
-- being RLS-scoped so a job counts as ours only when we can see it. An outgoing
-- entry needs no job lookup at all: our wallet paid it, so the job was ours.
--
-- Paying a landlord we do not own — an alliance-mate's structure, or a
-- stranger's — remains tax paid and no saving whatever.
--
-- `isk_paid` is unchanged, and still counts a character's job from the incoming
-- receipt (no character wallet journal exists to read their side from) while
-- taking a corporation's from the outgoing entry in its own wallet, so one
-- charge is billed exactly once.
drop function if exists public.structure_tax_revenue(bigint, timestamptz);

create function public.structure_tax_revenue(structure_id bigint, since timestamptz)
returns table (
  payer_id bigint,
  day date,
  jobs bigint,
  isk numeric,
  self_paid_jobs bigint,
  isk_self_paid numeric,
  paid_jobs bigint,
  isk_paid numeric,
  total_jobs bigint,
  isk_total numeric
)
language sql
stable
as $$
  with tax as (
    select w.first_party_id, w.corporation_id, w.date, w.amount, w.context_id
    from public.corp_wallet_journal w
    where w.ref_type = 'industry_job_tax'
      and w.context_id is not null
      and w.date >= since
  ),
  taxed_jobs as (
    select distinct t.context_id as job_id from tax t
  ),
  -- Do WE own this structure? Any of our corporations owning it is enough; an
  -- alliance-mate's tile is on the page too, and paying them is rent.
  owned as (
    select exists (
      select 1
      from public.corp_structure cs
      where cs.structure_id = structure_tax_revenue.structure_id
        and cs.corporation_id in (select public.my_corporation_ids())
    ) as ours
  ),
  -- One call for the whole window rather than per row; the function dedupes to
  -- at most one location per job.
  located as (
    select f.job_id, f.station_id, f.facility_id
    from public.industry_job_tax_facility(array(select j.job_id from taxed_jobs j)) f
  ),
  -- Jobs of ours, either way they were installed. Both views are RLS-scoped to
  -- the caller, so somebody else's job renting our slots is absent.
  ours as (
    select cij.job_id from public.character_industry_job cij where cij.job_id in (select job_id from taxed_jobs)
    union
    select coj.job_id from public.corp_industry_job coj where coj.job_id in (select job_id from taxed_jobs)
  ),
  -- The character-installed subset, which decides only that a charge is billed
  -- once — never whether it was billed at our own rate.
  personal as (
    select cij.job_id from public.character_industry_job cij where cij.job_id in (select job_id from taxed_jobs)
  ),
  scoped as (
    select
      t.first_party_id,
      t.date,
      t.amount,
      p.job_id is not null as is_personal,
      case
        -- We paid it, so the job was ours; all that remains is whether the
        -- structure is.
        when t.amount < 0 then (select ours from owned)
        -- Somebody paid us. It is an own-rate charge when the job was ours and
        -- we own the structure it ran in.
        else o.job_id is not null and (select ours from owned)
      end as own_rate
    from tax t
    join located l on l.job_id = t.context_id
    left join ours o on o.job_id = t.context_id
    left join personal p on p.job_id = t.context_id
    -- Upwell structures share the id between station_id and facility_id; jobs in
    -- NPC stations carry only station_id. Same coalesce the revenue page uses.
    where coalesce(l.station_id, l.facility_id) = structure_tax_revenue.structure_id
  )
  select
    s.first_party_id                                                as payer_id,
    (s.date at time zone 'UTC')::date                               as day,
    count(*) filter (where s.amount > 0)                            as jobs,
    coalesce(sum(s.amount) filter (where s.amount > 0), 0)          as isk,
    count(*) filter (where s.own_rate)                              as self_paid_jobs,
    coalesce(sum(abs(s.amount)) filter (where s.own_rate), 0)       as isk_self_paid,
    count(*) filter (where s.amount < 0 or s.is_personal)           as paid_jobs,
    coalesce(sum(abs(s.amount)) filter (where s.amount < 0 or s.is_personal), 0) as isk_paid,
    count(*)                                                        as total_jobs,
    coalesce(sum(abs(s.amount)), 0)                                 as isk_total
  from scoped s
  -- Positional, so the output column names can't shadow anything in `scoped`.
  group by 1, 2
  order by 2 desc, 4 desc;
$$;
