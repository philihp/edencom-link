-- structure_tax_revenue(): report the same three measures /structure does.
--
-- The list page now separates what others paid US (revenue), what WE paid
-- whoever owns a structure (taxes paid), and the subset of that billed at our
-- own rate (the cost-avoidance basis). This function knew only the first two,
-- and its second one was wrong in the same way the list page's was:
-- `isk_self_paid` summed EVERY outgoing entry with no owner test, so tax paid
-- as rent into an alliance-mate's structure was reported as tax we had billed
-- ourselves. It also missed a member's personal job entirely — that charge
-- arrives as an incoming entry, and no character wallet journal exists to read
-- the paying side from, so it was only ever counted as revenue.
--
-- The rules below mirror src/app/structure/taxLedger.ts, which is the canonical
-- statement of them:
--
--   isk         incoming. Somebody paid to run a job here.
--   isk_paid    every charge our side paid: all outgoing entries, plus incoming
--               ones whose job one of OUR CHARACTERS installed. A corp job's
--               payment is already the outgoing entry in that corp's own
--               wallet, so counting the landlord's receipt too would bill it
--               twice.
--   isk_self_paid  the subset billed at our own rate — the installer's own
--               corporation owns this structure. Only that can be scaled by
--               public/own into a saving; a structure bills a corporation it
--               does not contain at whatever rate it likes.
--   isk_total   every entry once, whichever direction. What the payer
--               leaderboard ranks, since "who put industry through here" is the
--               same question whichever wallet the tax came out of. Revenue and
--               taxes paid deliberately overlap (a member billing their own
--               corp is both), so they cannot be added for that purpose.
--
-- The return type changes, so the function is dropped rather than replaced —
-- CREATE OR REPLACE cannot alter OUT parameters. SECURITY INVOKER throughout:
-- corp_structure, character_industry_job and registration are all RLS-scoped to
-- the caller, so a job is only ever "ours" when we can actually see it.
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
  with owner as (
    select cs.corporation_id
    from public.corp_structure cs
    where cs.structure_id = structure_tax_revenue.structure_id
    limit 1
  ),
  tax as (
    select w.first_party_id, w.corporation_id, w.date, w.amount, w.context_id
    from public.corp_wallet_journal w
    where w.ref_type = 'industry_job_tax'
      and w.context_id is not null
      and w.date >= since
  ),
  -- One call for the whole window rather than per row; the function dedupes to
  -- at most one location per job.
  located as (
    select f.job_id, f.station_id, f.facility_id
    from public.industry_job_tax_facility(array(select distinct t.context_id from tax t)) f
  ),
  -- Our characters' personal jobs, and the corporation each installer was in.
  -- Corp jobs are deliberately absent: it is the outgoing entry in the paying
  -- corp's own wallet that records those, not the receipt.
  personal as (
    select cij.job_id, r.corporation_id
    from public.character_industry_job cij
    join public.registration r on r.id = cij.registration_id
  ),
  scoped as (
    select
      t.first_party_id,
      t.corporation_id,
      t.date,
      t.amount,
      p.corporation_id is not null as is_personal,
      -- Was this charge billed at our own rate? For an outgoing entry the payer
      -- IS the installer; for an incoming one the wallet belongs to the
      -- landlord, so the installer comes from the job instead.
      case
        when t.amount < 0 then t.corporation_id = (select corporation_id from owner)
        else p.corporation_id is not null and p.corporation_id = (select corporation_id from owner)
      end as own_rate
    from tax t
    join located l on l.job_id = t.context_id
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
