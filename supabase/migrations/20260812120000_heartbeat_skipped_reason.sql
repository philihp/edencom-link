-- Tell "the extract broke" apart from "this pilot was never allowed to ask".
--
-- The corp endpoints need an in-game role (director, accountant, …) on top of
-- the OAuth scope, so a corp job run under a character who doesn't hold it gets
-- a 403. Until now that closed the heartbeat with ok=false, and /jobs rendered
-- the corp as '✗ failed' every six hours — for something that is not a failure
-- at all but a permission fact about the character. It is a no-op: nothing was
-- pulled, nothing went wrong, and re-running it will do exactly the same thing.
--
-- skipped_reason records that outcome as its own thing (ok stays true, error
-- stays null) with the sentence the page shows on hover. Null on every other
-- row: a real run, an open row, or anything written before this column.

alter table public.heartbeat
  add column skipped_reason text;

comment on column public.heartbeat.skipped_reason is
  'Why the run was a permitted no-op rather than a pull (e.g. the character holds no director role); null for real runs. ok stays true.';

-- latest_heartbeats() is what /jobs reads, so the new outcome has to travel
-- through it. Adding an OUT column changes the return type, which CREATE OR
-- REPLACE cannot do (same reason as #754 and 20260812000000), so drop first.
-- Callers reading fewer columns — the MCP data_refreshed stamp in
-- src/app/api/mcp/lib.ts — are unaffected; the argument list is unchanged.

drop function if exists public.latest_heartbeats();

create function public.latest_heartbeats()
returns table (
  job text,
  registration_id uuid,
  corporation_id bigint,
  ended_at timestamptz,
  ok boolean,
  error text,
  skipped_reason text
)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.registration_id, h.corporation_id, h.ended_at, h.ok, h.error, h.skipped_reason
  from public.heartbeat h
  where h.ended_at is not null
    and h.ended_at > now() - interval '30 days'
  order by h.job, h.owner_key, h.ended_at desc;
$$;

grant execute on function public.latest_heartbeats() to authenticated;
