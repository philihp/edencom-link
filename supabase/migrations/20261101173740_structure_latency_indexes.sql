-- Two reads /structure still made without an index to lead them
-- (docs/structure-measure-rollup.md "Where the remaining time went").
--
-- fetchLatestSystemIndexes() asks for the newest recorded_at, then for that
-- snapshot's rows. industry_system_index is append-only (640k rows, 2.5k
-- snapshots on 2026-11-01) and its one index leads with system_id, so both
-- were whole-table passes, one after the other: 482 ms + 819 ms mean, 2.0 s +
-- 2.3 s worst, by pg_stat_statements. Leading with recorded_at makes the
-- first a single index probe and the second one snapshot's ~560 rows. The
-- same function backs /indexes, /structure/[structureId] and MCP
-- industry_cost_indices.
create index if not exists industry_system_index_recorded_at_idx
  on public.industry_system_index (recorded_at desc);

-- The clone-bay revenue footer: two ref_types over the window, every
-- corporation the caller reads. corp_wallet_journal_corp_date_idx leads with
-- the corporation, so the window was walked per corp and filtered on
-- ref_type (249 ms mean, 1.8 s worst). Not partial: PostgREST binds the
-- ref_type list as a parameter, which a generic plan cannot prove implies an
-- index predicate.
create index if not exists corp_wallet_journal_ref_type_date_idx
  on public.corp_wallet_journal (ref_type, date desc);
