-- Track which code deployment (git commit sha) produced each completed SDE
-- mirror, so the nightly sde-mirror workflow can skip a full re-ingest when
-- CCP's build is unchanged AND the currently-deployed commit already produced
-- the mirror AND it is less than 7 days old (see planMirror in
-- src/jobs/sdeMirror.js). Nullable: rows completed before this migration have no
-- recorded commit, so they read as "produced by an unknown commit" and the next
-- run re-ingests and stamps the commit — the safe direction.
alter table public.sde_mirror_state add column if not exists commit_sha text;
