-- SQL-level coverage for mail_send_log (docs/eve-mail.md "The send path"):
-- the rules Postgres enforces rather than the app does.
--
--   * an owner reads their own sends and nobody else's; anon reads nothing;
--   * `authenticated` can neither insert nor update — every write goes through
--     the service role, from src/app/mail/lib.ts, the only thing that sends;
--   * request_id is used once: the unique index refuses a reused key whatever
--     became of the first attempt, which is what keeps a retried send from
--     going out twice (the race the lib's own read cannot close).
--
-- Run against a THROWAWAY database from the repo root (it creates stand-in
-- tables named after the real ones): DATABASE_URL='postgresql://…/throwaway'
-- pnpm run test:sql. Everything runs in one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

create table public.registration (
  id uuid primary key,
  user_id uuid
);

-- The table under test, verbatim from the migration minus the auth.users FK.
create table public.mail_send_log (
  id              bigint generated always as identity primary key,
  user_id         uuid not null,
  registration_id uuid not null references public.registration(id) on delete cascade,
  request_id      uuid not null,
  recipients      jsonb not null,
  subject         text not null,
  body            text not null,
  approved_cost   bigint not null default 0,
  mail_id         bigint,
  source          text not null default 'cli',
  status          text not null check (status in ('pending', 'ok', 'error')),
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create unique index mail_send_log_request_id_idx on public.mail_send_log (request_id);
create index mail_send_log_registration_idx on public.mail_send_log (registration_id, created_at desc);

alter table public.mail_send_log enable row level security;
create policy "Users read own mail sends"
  on public.mail_send_log
  for select
  to authenticated
  using (user_id = (select auth.uid()));

grant usage on schema public to anon, authenticated;
grant select on public.mail_send_log to authenticated;
grant all    on public.mail_send_log to service_role;

\set alice 'a0000000-0000-0000-0000-000000000000'
\set bob   'b0000000-0000-0000-0000-000000000000'
\set areg  '00000000-0000-0000-0000-0000000000aa'
\set breg  '00000000-0000-0000-0000-0000000000bb'
\set key   '22222222-2222-2222-2222-222222222222'

insert into public.registration values (:'areg', :'alice'), (:'breg', :'bob');

-- Written as the service role would: directly, no policy involved.
insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
values
  (:'alice', :'areg', :'key', '[{"recipient_id":90000001,"recipient_type":"character"}]', 'o7', 'fly safe', 'pending'),
  (:'bob',   :'breg', '33333333-3333-3333-3333-333333333333', '[{"recipient_id":98000001,"recipient_type":"corporation"}]', 'ops', 'form up', 'ok');

-- ── The owner reads their own sends, and only those ──────────────────────
set local role authenticated;
select set_config('test.uid', :'alice', true);

do $$
declare
  n int;
  other int;
begin
  select count(*) into n from public.mail_send_log;
  assert n = 1, format('alice should read exactly her one send, read %s', n);
  select count(*) into other from public.mail_send_log
    where user_id = 'b0000000-0000-0000-0000-000000000000';
  assert other = 0, 'alice read one of bob''s sends';
end $$;

-- An account with no sends reads none.
select set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
do $$
declare
  n int;
begin
  select count(*) into n from public.mail_send_log;
  assert n = 0, format('a third account read %s sends', n);
end $$;

-- ── authenticated cannot write ───────────────────────────────────────────
-- A browser session must never be able to record a send that did not happen,
-- nor flip a pending row to ok.
select set_config('test.uid', :'alice', true);
do $$
begin
  insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
  values ('a0000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000aa',
          '44444444-4444-4444-4444-444444444444', '[]', 's', 'b', 'ok');
  raise exception 'authenticated inserted into mail_send_log';
exception when insufficient_privilege then
  null;
end $$;

do $$
begin
  update public.mail_send_log set status = 'ok', mail_id = 1;
  raise exception 'authenticated updated mail_send_log';
exception when insufficient_privilege then
  null;
end $$;

-- ── anon reads nothing ───────────────────────────────────────────────────
reset role;
set local role anon;
do $$
begin
  perform count(*) from public.mail_send_log;
  raise exception 'anon read mail_send_log';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- ── A request id is spent, whatever became of the attempt ────────────────
-- Checked while pending, after ok, and after error: the lib treats them alike.
do $$
declare
  st text;
begin
  foreach st in array array['pending', 'ok', 'error'] loop
    update public.mail_send_log set status = st
      where request_id = '22222222-2222-2222-2222-222222222222';
    begin
      insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
      values ('a0000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000aa',
              '22222222-2222-2222-2222-222222222222', '[]', 'again', 'again', 'pending');
      raise exception 'a reused request id was accepted while the first was %', st;
    exception when unique_violation then
      null;
    end;
  end loop;
end $$;

-- The key is global: another account cannot reuse it either.
do $$
begin
  insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
  values ('b0000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000bb',
          '22222222-2222-2222-2222-222222222222', '[]', 'x', 'y', 'pending');
  raise exception 'another account reused the same request id';
exception when unique_violation then
  null;
end $$;

-- A fresh key is always available.
insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
values (:'alice', :'areg', '55555555-5555-5555-5555-555555555555', '[]', 'next', 'next', 'pending');

-- ── The status is one of three ───────────────────────────────────────────
do $$
begin
  insert into public.mail_send_log (user_id, registration_id, request_id, recipients, subject, body, status)
  values ('a0000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-0000000000aa',
          '66666666-6666-6666-6666-666666666666', '[]', 's', 'b', 'sent');
  raise exception 'a status outside pending/ok/error was accepted';
exception when check_violation then
  null;
end $$;

rollback;
