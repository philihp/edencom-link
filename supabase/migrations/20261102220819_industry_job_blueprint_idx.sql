-- /blueprint/[itemId] (docs/item-pages.md) reads a blueprint's run history by
-- the job tables' blueprint_id, which they have always carried and never
-- indexed: without this, each page view scanned the owner's whole job history.
-- Partial on current rows, which is all the two job views show.
create index if not exists character_industry_job_over_time_blueprint_idx
  on public.character_industry_job_over_time (blueprint_id) where is_current;
create index if not exists corp_industry_job_over_time_blueprint_idx
  on public.corp_industry_job_over_time (blueprint_id) where is_current;
