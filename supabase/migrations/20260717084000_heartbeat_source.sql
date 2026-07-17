-- Persist the execution-path provenance callers already pass to
-- recordHeartbeat (src/supabase.js): the queue consumer sends 'vercel', the
-- direct cron routes 'vercel-cron', and workflow steps 'vercel-workflow',
-- but until now recordHeartbeat dropped the value because the table had no
-- column for it. GitHub Actions runs are stamped 'github' (derived from
-- GITHUB_RUN_ID). Null for local CLI runs and the per-character/per-corp
-- loop rows, which don't know how they were invoked. Existing rows stay
-- null — provenance starts accruing from deploy.
alter table public.heartbeat add column source text;
