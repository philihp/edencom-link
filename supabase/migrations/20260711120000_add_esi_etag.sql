-- Last ETag seen per ESI conditional-request cache key, so the extract jobs can
-- send If-None-Match and skip re-processing an unchanged snapshot on a 304 (see
-- esiConditionalJson in src/esi.js and getEsiEtag/putEsiEtag in src/supabase.js).
-- cache_key is "<job>:<registration uuid>" for the per-character snapshot jobs
-- (character-orders / -wallet-transactions / -industry-jobs). Internal cron
-- bookkeeping only: RLS is on with no policy, so only the service role reaches it.
create table if not exists public.esi_etag (
  cache_key  text primary key,
  etag       text not null,
  updated_at timestamptz not null default now()
);

alter table public.esi_etag enable row level security;
grant all on public.esi_etag to service_role;
