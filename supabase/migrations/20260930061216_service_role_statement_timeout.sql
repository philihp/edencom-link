-- A statement timeout sized for batch work on the service role.
--
-- Every extract job and every server-side service client reaches Postgres
-- through PostgREST, which connects as `authenticator` (statement_timeout
-- 8s, lock_timeout 8s) and switches to the JWT's role. PostgREST applies a
-- role's own `ALTER ROLE ... SET` settings when it switches, which is how
-- anon gets 3s and authenticated 8s; service_role had none, so it inherited
-- the connection's 8s. On 2026-09-30 fifty asset reconciles ran at once and
-- 43 of them died on "canceling statement due to statement timeout": a limit
-- meant for a browser request, applied to a batch upsert under contention.
--
-- Five minutes is the job's budget, not the request's: a workflow step has
-- its own duration cap, and a reconcile that genuinely takes minutes should
-- finish rather than be retried into the same wall. The database default
-- stays at two minutes for everyone else.
alter role service_role set statement_timeout = '5min';
alter role service_role set lock_timeout = '30s';

-- PostgREST reads role settings on a config reload, not a schema reload.
notify pgrst, 'reload config';
