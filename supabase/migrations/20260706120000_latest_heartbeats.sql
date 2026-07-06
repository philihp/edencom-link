-- The most recent completed heartbeat per job per owner (character, corp, or
-- whole-job), driving the freshness dots on /character/refresh. DISTINCT ON
-- over owner_key rather than the two nullable id columns so the account-wide
-- rows (both ids null) collapse to one row per job instead of being merged by
-- null-grouping quirks. Floored to the last 30 days to keep the sort bounded
-- as heartbeat grows — anything older is stale enough to read as "never".
-- SECURITY INVOKER (the default), so heartbeat's RLS scopes the rows to the
-- caller: their own characters, their corps, and the shared account-wide jobs.
-- Mirrors the function added to schema.sql.
create or replace function public.latest_heartbeats()
returns table (job text, character_id uuid, corporation_id bigint, ended_at timestamptz)
language sql
stable
as $$
  select distinct on (h.job, h.owner_key)
    h.job, h.character_id, h.corporation_id, h.ended_at
  from public.heartbeat h
  where h.ended_at is not null
    and h.ended_at > now() - interval '30 days'
  order by h.job, h.owner_key, h.ended_at desc;
$$;

grant execute on function public.latest_heartbeats() to authenticated;

-- Lets the header's "Refreshed N minutes ago" indicator find a user's most
-- recent completed extract with an index scan on every page render.
create index if not exists heartbeat_user_id_ended_at_idx on public.heartbeat (user_id, ended_at desc);
