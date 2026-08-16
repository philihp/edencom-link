-- BRIN standardization, batch 1: the small SCD-2 tables
-- (docs/brin-indexes/README.md — "standardize, measured").
--
-- Every *_over_time reconcile appends its new row versions at the end of the
-- heap, so valid_from climbs with physical position — the correlation BRIN
-- summarises well. The time-travel predicate these serve
-- (valid_from <= as_of and (is_current or valid_until >= as_of)) is
-- btree-hostile (the OR) and BRIN-shaped (the range half). Measured precedent
-- on market_price_over_time at 2M rows: btree 60 MB vs BRIN 40 kB for ~2.5 ms
-- on deep history, correlation 0.9996 after 60 simulated churn cycles
-- (20260816040000_market_price.sql, docs/market-prices/README.md "Storage").
--
-- These five are batched — unlike the large tables, which ship one per PR
-- against a request.timing baseline — because they are bounded by character
-- count times a small per-character set (clones, learned skills, one ship,
-- fittings, dens), so the index costs kilobytes, no serving RPC exists yet to
-- regress, and standardizing them now means they are already correct if they
-- grow. Evidence for this batch is plan-level only, per the doc's sequencing.
-- Deliberately absent: character_blueprint_over_time (size is a production
-- fact — it joins a later PR once the doc's sizing query has run) and the
-- large tables (assets, orders, industry jobs).
--
-- Plain create index, not concurrently: the CLI applies migrations
-- transactionally, and a BRIN build is one sequential heap pass over small
-- tables — the writers it could briefly block are the 6-hourly extract jobs.

create index character_clone_over_time_asof_idx
  on public.character_clone_over_time using brin (valid_from) with (pages_per_range = 32);

create index character_skill_over_time_asof_idx
  on public.character_skill_over_time using brin (valid_from) with (pages_per_range = 32);

create index character_ship_over_time_asof_idx
  on public.character_ship_over_time using brin (valid_from) with (pages_per_range = 32);

create index character_fitting_over_time_asof_idx
  on public.character_fitting_over_time using brin (valid_from) with (pages_per_range = 32);

create index character_mercenary_den_over_time_asof_idx
  on public.character_mercenary_den_over_time using brin (valid_from) with (pages_per_range = 32);
