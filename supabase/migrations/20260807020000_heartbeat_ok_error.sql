-- Record whether a heartbeat's run succeeded. Both heartbeat wrappers
-- (withHeartbeat in src/jobs/lib.js, runJobWithHeartbeat in
-- src/workflows/lib.ts) close their start/end pair from a finally, so until
-- now a run that threw wrote the same end row as one that succeeded — a
-- nightly job could fail every night and the table couldn't say so (the gap
-- documented in docs/jobs-page.md's "Status semantics"). The wrappers now
-- stamp the end row with ok=true, or ok=false plus the error's message.
--
-- Both columns are nullable on purpose: a still-open row has no outcome yet,
-- and every row written before this migration has an unknown one — backfilling
-- either would be a lie. Failure visibility starts at deploy time.

alter table public.heartbeat
  add column ok boolean,
  add column error text;

comment on column public.heartbeat.ok is
  'Whether the run succeeded; written with the end heartbeat, null for open rows and rows predating the column.';
comment on column public.heartbeat.error is
  'The failure''s message (truncated), null when ok.';
