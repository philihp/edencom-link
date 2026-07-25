-- Let signed-in callers run the SCD-2 time-travel snapshot functions.
--
-- These were written for the Google Sheets IMPORTDATA endpoints, which resolve
-- an api_token and then query as the service role, so execute was only ever
-- granted to service_role. The MCP tools instead run on a client carrying the
-- caller's own OAuth token (role `authenticated`), so they couldn't call these
-- at all — leaving the `as_of` history unreachable through MCP even though the
-- functions and the underlying SCD-2 history both exist.
--
-- Safe to widen: every one of these is SECURITY INVOKER (no `security
-- definer`), so RLS on the underlying *_over_time tables still scopes rows to
-- the caller's own characters/corps. The character_ids argument only narrows
-- further. service_role keeps its existing grant.
--
-- Timestamped 01:00:00 rather than 00:00:00 because 20260725000000 is already
-- taken by blueprint_search.sql on main; two files sharing a version collide in
-- the migration history table, which keys on the version, not the filename.
grant execute on function public.character_asset_snapshot_at(uuid[], timestamptz) to authenticated;
grant execute on function public.character_orders(uuid[], timestamptz) to authenticated;
grant execute on function public.character_industry_jobs(uuid[], boolean, timestamptz) to authenticated;
grant execute on function public.corp_industry_jobs(uuid[], boolean, timestamptz) to authenticated;
