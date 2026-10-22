-- ── mail_send_log ─────────────────────────────────────────────────────────
-- Every EVE mail this deployment asked ESI to send, written BEFORE the call
-- (docs/eve-mail.md "The send path"). The second ESI write path after the
-- fittings archive, and built the way fitting_write_log is: the row carries
-- the whole draft — recipients, subject, body, the CSPA charge the caller
-- approved — so the audit trail says exactly what went out, or what was about
-- to when something failed, without depending on the character-mail extract
-- having seen it.
--
-- request_id is caller-minted and used once: a client that lost the response
-- retries under the same id and is refused by the unique index rather than
-- sending the mail twice. Any row spends its id, whatever its status.
--
-- Append-only in practice: rows are inserted 'pending' and updated once to
-- 'ok' (with ESI's mail_id) or 'error'. Nothing deletes from here except the
-- registration's own cascade.
create table public.mail_send_log (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users(id) on delete cascade,
  registration_id uuid not null references public.registration(id) on delete cascade,
  request_id      uuid not null,
  -- [{ recipient_id, recipient_type }], as sent.
  recipients      jsonb not null,
  subject         text not null,
  body            text not null,
  -- ISK the caller agreed to pay in CSPA charges; a send that would cost more
  -- fails at ESI (520) and is never retried with a higher figure.
  approved_cost   bigint not null default 0,
  -- ESI's answer; null until it answers, and on error.
  mail_id         bigint,
  -- 'cli' | 'mcp' | 'web' as callers arrive.
  source          text not null default 'cli',
  status          text not null check (status in ('pending', 'ok', 'error')),
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create unique index mail_send_log_request_id_idx on public.mail_send_log (request_id);
create index mail_send_log_registration_idx on public.mail_send_log (registration_id, created_at desc);

alter table public.mail_send_log enable row level security;
-- The owner's to read; written only by the service role, from
-- src/app/mail/lib.ts, the only thing allowed to send. No anon grant.
create policy "Users read own mail sends"
  on public.mail_send_log
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant select on public.mail_send_log to authenticated;
grant all    on public.mail_send_log to service_role;
