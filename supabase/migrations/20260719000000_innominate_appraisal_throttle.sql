-- Global throttle for the innomin.at appraisal API (see src/innominate.ts).
-- The provider allows 200 requests/hour for the whole deployment, so every
-- appraisal call is funnelled through a Vercel queue (topic "innominate",
-- consumer at /api/queue/innominate) that drains at most one request every 18
-- seconds (200/hour) across ALL lambda instances and deployments. In-process
-- state can't coordinate that — separate serverless instances don't share
-- memory — so the throttle timestamp and the pending/finished results live in
-- these two service-role-only tables (RLS on, no policy: only the service role,
-- which the queue consumer and the MCP tool use, can reach them).

-- ── innominate_throttle ──────────────────────────────────────────────────────
-- Singleton leaky-bucket row: the timestamp of the last request the consumer was
-- allowed to send. `innominate_try_acquire()` advances it atomically.
create table if not exists public.innominate_throttle (
  id               boolean primary key default true check (id),
  last_request_at  timestamptz not null default 'epoch'
);
insert into public.innominate_throttle (id) values (true) on conflict (id) do nothing;

alter table public.innominate_throttle enable row level security;
grant all on public.innominate_throttle to service_role;

-- ── innominate_appraisal ─────────────────────────────────────────────────────
-- One row per distinct (market + sorted item list) request, keyed by request_key
-- (the same hash the in-process cache uses). The producer upserts a 'pending'
-- row and blocks polling it; the consumer flips it to 'done' (with the mapped
-- Appraisal in `result`) or 'error' (with { kind, message, retryAfterSeconds } in
-- `error`). A fresh 'done' row (< 5 min) doubles as the global price cache.
create table if not exists public.innominate_appraisal (
  request_key  text primary key,
  market       text not null,
  items        jsonb not null,
  status       text not null default 'pending' check (status in ('pending', 'done', 'error')),
  result       jsonb,
  error        jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists innominate_appraisal_updated_at_idx on public.innominate_appraisal (updated_at);

alter table public.innominate_appraisal enable row level security;
grant all on public.innominate_appraisal to service_role;

-- ── innominate_try_acquire(min_interval_seconds) ─────────────────────────────
-- Atomic leaky bucket. Advances last_request_at to now() only if at least
-- min_interval_seconds have elapsed since the previous request, returning
-- acquired=true. Otherwise returns acquired=false with wait_seconds until the
-- next slot, so the consumer can reschedule its queue message. The guarded
-- UPDATE is a single atomic statement, so concurrent consumers can't both
-- acquire the same slot.
create or replace function public.innominate_try_acquire(min_interval_seconds integer default 18)
returns table (acquired boolean, wait_seconds double precision)
language plpgsql
as $$
declare
  v_now timestamptz := now();
begin
  insert into public.innominate_throttle (id) values (true) on conflict (id) do nothing;

  update public.innominate_throttle
     set last_request_at = v_now
   where id = true
     and v_now - last_request_at >= make_interval(secs => min_interval_seconds);

  if found then
    return query select true, 0::double precision;
  else
    return query
      select false,
             greatest(
               extract(epoch from (make_interval(secs => min_interval_seconds) - (v_now - last_request_at))),
               0
             )::double precision
        from public.innominate_throttle
       where id = true;
  end if;
end;
$$;

grant execute on function public.innominate_try_acquire(integer) to service_role;
