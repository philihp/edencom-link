-- SQL-level coverage for the character-mail tables (docs/eve-mail.md PR 2):
-- character_mail, character_mail_label, character_mailing_list and
-- character_mail_sync. The rules Postgres enforces rather than the app does:
--
--   * an owner reads their own characters' rows in all four tables;
--   * a second account reads none of them;
--   * `anon` reads none of them (no grant, no policy);
--   * `authenticated` can neither insert nor update — every write is the
--     extract job on the service role;
--   * (registration_id, mail_id) is the identity, so two of our characters on
--     the same corp mail each keep their own row;
--   * removing the registration removes its mail (the one cascade).
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

-- Stand-in. The real registration carries much more; the policies read only
-- id and user_id.
create table public.registration (
  id uuid primary key,
  user_id uuid
);

-- The tables under test, verbatim from the migration.
create table public.character_mail (
  registration_id  uuid   not null references public.registration(id) on delete cascade,
  mail_id          bigint not null,
  from_id          bigint not null,
  subject          text,
  sent_at          timestamptz not null,
  is_read          boolean not null default false,
  labels           bigint[] not null default '{}',
  recipients       jsonb   not null default '[]',
  body             text,
  body_fetched_at  timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  primary key (registration_id, mail_id)
);
create index character_mail_body_owed_idx
  on public.character_mail (registration_id, sent_at desc) where body_fetched_at is null;
create index character_mail_from_idx on public.character_mail (registration_id, from_id);
create index character_mail_sent_idx on public.character_mail (registration_id, sent_at desc);

create table public.character_mail_label (
  registration_id uuid not null references public.registration(id) on delete cascade,
  label_id        bigint not null,
  name            text,
  color           text,
  unread_count    integer,
  primary key (registration_id, label_id)
);

create table public.character_mailing_list (
  registration_id uuid not null references public.registration(id) on delete cascade,
  mailing_list_id bigint not null,
  name            text,
  primary key (registration_id, mailing_list_id)
);

create table public.character_mail_sync (
  registration_id   uuid primary key references public.registration(id) on delete cascade,
  oldest_mail_id    bigint,
  backfill_complete boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table public.character_mail         enable row level security;
alter table public.character_mail_label   enable row level security;
alter table public.character_mailing_list enable row level security;
alter table public.character_mail_sync    enable row level security;

create policy "Users read own mail"
  on public.character_mail
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mail labels"
  on public.character_mail_label
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mailing lists"
  on public.character_mailing_list
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );
create policy "Users read own mail sync state"
  on public.character_mail_sync
  for select
  to authenticated
  using (
    registration_id in (
      select id from public.registration where user_id = (select auth.uid())
    )
  );

-- The policies' subquery reads registration as the caller; the real table
-- lets an owner read their own rows, which is all the stand-in needs.
grant usage on schema public to anon, authenticated;
grant select on public.registration to authenticated;

grant select on public.character_mail         to authenticated;
grant select on public.character_mail_label   to authenticated;
grant select on public.character_mailing_list to authenticated;
grant select on public.character_mail_sync    to authenticated;
grant all    on public.character_mail         to service_role;
grant all    on public.character_mail_label   to service_role;
grant all    on public.character_mailing_list to service_role;
grant all    on public.character_mail_sync    to service_role;

\set alice     'a0000000-0000-0000-0000-000000000000'
\set bob       'b0000000-0000-0000-0000-000000000000'
\set alice_reg '00000000-0000-0000-0000-0000000000aa'
\set alice_alt '00000000-0000-0000-0000-0000000000ab'
\set bob_reg   '00000000-0000-0000-0000-0000000000bb'

insert into public.registration values (:'alice_reg', :'alice'), (:'alice_alt', :'alice'), (:'bob_reg', :'bob');

-- Written as the service role would: directly, no policy involved. Mail 900
-- is a corp mail both of alice's characters received — one row each.
insert into public.character_mail (registration_id, mail_id, from_id, subject, sent_at, labels, recipients)
values
  (:'alice_reg', 900, 98000001, 'Corp op tonight', '2026-10-01T18:00:00Z', '{4}',
   '[{"recipient_id":98000001,"recipient_type":"corporation"}]'),
  (:'alice_alt', 900, 98000001, 'Corp op tonight', '2026-10-01T18:00:00Z', '{4}',
   '[{"recipient_id":98000001,"recipient_type":"corporation"}]'),
  (:'alice_reg', 901, 2112000001, 'Re: hauling', '2026-10-02T09:00:00Z', '{1}',
   '[{"recipient_id":2112000002,"recipient_type":"character"}]'),
  (:'bob_reg',   950, 2112000009, 'Private', '2026-10-03T09:00:00Z', '{1}', '[]');
insert into public.character_mail_label values
  (:'alice_reg', 1, 'Inbox', '#ffffff', 1),
  (:'bob_reg',   1, 'Inbox', '#ffffff', 0);
insert into public.character_mailing_list values
  (:'alice_reg', 145000001, 'Industry'),
  (:'bob_reg',   145000002, 'Secret Squirrels');
insert into public.character_mail_sync (registration_id, oldest_mail_id, backfill_complete) values
  (:'alice_reg', 900, true),
  (:'bob_reg',   950, false);

-- ── The identity is (registration_id, mail_id) ───────────────────────────
do $$
begin
  insert into public.character_mail (registration_id, mail_id, from_id, sent_at)
  values ('00000000-0000-0000-0000-0000000000aa', 900, 1, now());
  raise exception 'the same mail was stored twice for one character';
exception when unique_violation then
  null;
end $$;

-- ── Owner reads own rows, nobody else's ───────────────────────────────────
set local role authenticated;
do $$
declare
  n int;
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_mail;
  assert n = 3, format('alice sees %s mails, expected her 3 (900 twice, 901)', n);
  select count(*) into n from public.character_mail_label;
  assert n = 1, format('alice sees %s labels, expected 1', n);
  select count(*) into n from public.character_mailing_list;
  assert n = 1, format('alice sees %s mailing lists, expected 1', n);
  select count(*) into n from public.character_mail_sync;
  assert n = 1, format('alice sees %s sync rows, expected 1', n);
  select count(*) into n from public.character_mail where mail_id = 950;
  assert n = 0, 'alice read bob''s mail';

  perform set_config('test.uid', 'b0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_mail;
  assert n = 1, format('bob sees %s mails, expected his 1', n);
  select count(*) into n from public.character_mailing_list where mailing_list_id = 145000001;
  assert n = 0, 'bob read alice''s mailing list';
  select count(*) into n from public.character_mail_sync;
  assert n = 1, format('bob sees %s sync rows, expected 1', n);

  -- A signed-in session with no uid (or an account with no characters) sees
  -- nothing at all.
  perform set_config('test.uid', 'c0000000-0000-0000-0000-000000000000', true);
  select count(*) into n from public.character_mail;
  assert n = 0, format('a stranger saw %s mails', n);
  perform set_config('test.uid', '', true);
  select count(*) into n from public.character_mail;
  assert n = 0, format('a uid-less session saw %s mails', n);
end $$;

-- ── authenticated cannot write, not even their own rows ──────────────────
-- No insert/update policy AND no grant: refused before RLS is consulted.
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.character_mail (registration_id, mail_id, from_id, sent_at)
  values ('00000000-0000-0000-0000-0000000000aa', 999, 1, now());
  raise exception 'authenticated inserted a mail';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.character_mail set is_read = true where mail_id = 901;
  raise exception 'authenticated updated a mail';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  insert into public.character_mail_label (registration_id, label_id, name)
  values ('00000000-0000-0000-0000-0000000000aa', 256, 'Forged');
  raise exception 'authenticated inserted a label';
exception when insufficient_privilege then
  null;
end $$;
do $$
begin
  perform set_config('test.uid', 'a0000000-0000-0000-0000-000000000000', true);
  update public.character_mail_sync set backfill_complete = false;
  raise exception 'authenticated updated the sync state';
exception when insufficient_privilege then
  null;
end $$;
reset role;

-- ── anon reads nothing ────────────────────────────────────────────────────
-- No grant to anon anywhere. Should a database's default privileges hand one
-- out regardless, there is still no anon policy, so the read comes back empty
-- rather than refused; either outcome passes, a single row fails.
set local role anon;
do $$
declare
  n int;
  t text;
begin
  foreach t in array array['character_mail', 'character_mail_label', 'character_mailing_list', 'character_mail_sync'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      assert n = 0, format('anon read %s rows of %s', n, t);
    exception when insufficient_privilege then
      null;
    end;
  end loop;
end $$;
reset role;

-- ── Unlinking the character removes its mail ─────────────────────────────
delete from public.registration where id = :'alice_alt';
do $$
declare
  n int;
begin
  select count(*) into n from public.character_mail where registration_id = '00000000-0000-0000-0000-0000000000ab';
  assert n = 0, 'the alt''s mail outlived its registration';
  select count(*) into n from public.character_mail where registration_id = '00000000-0000-0000-0000-0000000000aa';
  assert n = 2, 'unlinking the alt touched the main''s mail';
end $$;

rollback;
