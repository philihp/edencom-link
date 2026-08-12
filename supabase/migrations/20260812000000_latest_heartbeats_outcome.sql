-- Carry the run's outcome through latest_heartbeats(), so /jobs can tell a job
-- that last *ran* from one that last *worked*. heartbeat.ok/error landed in
-- 20260807020000_heartbeat_ok_error, but the function every UI reads went on
-- returning only the timestamp — a character whose token died shows a red-ish
-- freshness dot and nothing more, which is the gap docs/jobs-page.md's status
-- table closes with '✗ failed'.
--
-- Adding OUT columns changes the function's return type, which CREATE OR
-- REPLACE cannot do (same reason #754 had to drop this one), so drop first.
-- Callers reading only (job, registration_id, corporation_id, ended_at) — the
-- MCP data_refreshed stamp in src/app/api/mcp/lib.ts — are unaffected: the new
-- columns are additional, and the argument list is unchanged.

drop function if exists public.latest_heartbeats();

create function public.latest_heartbeats()
returns table (
  job text,
  registration_id uuid,
  corporation_id bigint,
  ended_at timestamptz,
  ok boolean,
  error text
)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.registration_id, h.corporation_id, h.ended_at, h.ok, h.error
  from public.heartbeat h
  where h.ended_at is not null
    and h.ended_at > now() - interval '30 days'
  order by h.job, h.owner_key, h.ended_at desc;
$$;

grant execute on function public.latest_heartbeats() to authenticated;
