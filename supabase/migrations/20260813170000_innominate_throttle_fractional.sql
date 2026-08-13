-- ── innominate_try_acquire: fractional intervals ─────────────────────────────
-- The appraisal provider has authorized this deployment for up to 150
-- requests/minute, so the drain rate rises to one request every 0.5 seconds
-- (120/minute — the difference is the buffer; see THROTTLE_SECONDS in
-- src/innominate.ts). A sub-second interval can't pass through the old
-- integer parameter, so the function is recreated taking double precision.
-- Dropped rather than replaced: create or replace can't change an argument
-- type. The drop-then-create window is safe — the only caller is the queue
-- consumer, whose failed RPC surfaces as a retried queue message.
drop function if exists public.innominate_try_acquire(integer);

create or replace function public.innominate_try_acquire(min_interval_seconds double precision default 0.5)
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

grant execute on function public.innominate_try_acquire(double precision) to service_role;
