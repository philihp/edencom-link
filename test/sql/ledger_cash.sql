-- SQL-level coverage for migration 20261126210114_ledger_cash.sql (ledger
-- stage 2, docs/ledger/stage-2.md): ledger_account, ledger_ref_type, the view
-- ledger_cash_line, ledger_group() and ledger_cash_statement().
--
-- Pinned here:
--   I-4   the two lines of each journal row sum to zero;
--   I-5   exactly two lines for each journal row with an amount, none for a
--         row with a null amount; the account by the sign, 9000 when unmapped;
--   I-7   an internal transfer pairs on the entry id, and one with no pair is
--         listed; a corporation's tax paid to itself is paired by its hidden
--         credit;
--   I-11  an outsider reads zero lines and gets an empty statement; a member
--         who is not a director gets no corporation wallet in the group; anon
--         reads nothing;
--   the statement's window rules, its JSON, the proven rule;
--   the rollback drops the five objects and no source table.
--
-- Run against a THROWAWAY database from the repo root:
--
--   DATABASE_URL='postgresql://…/throwaway' pnpm run test:sql
--
-- Everything runs inside one transaction and rolls back.
begin;

do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;

create schema if not exists auth;
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

-- Stand-ins with the production policies.
create table public.registration (
  id uuid primary key,
  user_id uuid,
  character_id bigint not null,
  corporation_id bigint
);
alter table public.registration enable row level security;
create policy "own registrations" on public.registration for select to authenticated
  using (user_id = (select auth.uid()));
grant select on public.registration to anon, authenticated;

create or replace function public.my_corporation_ids()
returns setof bigint
language sql
stable
as $$
  select r.corporation_id
  from public.registration r
  where r.user_id = (select auth.uid()) and r.corporation_id is not null;
$$;
grant execute on function public.my_corporation_ids() to authenticated;

create table public.character_wallet_journal (
  registration_id uuid not null references public.registration (id),
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  primary key (registration_id, entry_id)
);
alter table public.character_wallet_journal enable row level security;
create policy "Users read own journal" on public.character_wallet_journal for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.character_wallet_journal to authenticated;

create table public.corp_wallet_journal (
  corporation_id bigint not null,
  division smallint not null,
  entry_id bigint not null,
  date timestamptz not null,
  ref_type text not null,
  amount numeric(20, 2),
  balance numeric(20, 2),
  first_party_id bigint,
  second_party_id bigint,
  context_id bigint,
  context_id_type text,
  primary key (corporation_id, division, entry_id)
);
alter table public.corp_wallet_journal enable row level security;
create policy "Users read journal for own corps" on public.corp_wallet_journal for select to authenticated
  using (corporation_id in (
    select corporation_id from public.registration
    where user_id = (select auth.uid()) and corporation_id is not null
  ));
grant select on public.corp_wallet_journal to authenticated;

create table public.corp_job_access (
  registration_id uuid not null references public.registration (id),
  corporation_id bigint not null,
  job text not null,
  primary key (registration_id, corporation_id, job)
);
alter table public.corp_job_access enable row level security;
create policy "Users read own corp job access" on public.corp_job_access for select to authenticated
  using (registration_id in (select id from public.registration where user_id = (select auth.uid())));
grant select on public.corp_job_access to authenticated;

\ir ../../supabase/migrations/20261119091512_ledger_check.sql
\ir ../../supabase/migrations/20261120104657_ledger_hidden_credits.sql
\ir ../../supabase/migrations/20261126210114_ledger_cash.sql

-- Account A: characters a1 (char 9001) and a2 (char 9002), both in corp
-- 98000001; a1 directs it. Account B: b1 (char 9101), a member of 98000001
-- who is not a director. Account C: no character (the outsider).
insert into public.registration values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 9001, 98000001),
  ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 9002, 98000001),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000b', 9101, 98000001);
insert into public.corp_job_access values
  ('00000000-0000-0000-0000-0000000000a1', 98000001, 'corp-structures'),
  -- A grant for a corporation a1 has left: not a directorship.
  ('00000000-0000-0000-0000-0000000000a1', 98000777, 'corp-structures'),
  -- Another job is not the director proof.
  ('00000000-0000-0000-0000-0000000000b1', 98000001, 'corp-assets');

-- The ref_types the tests use, with known accounts (the seed may change).
delete from public.ledger_ref_type where ref_type in
  ('bounty_prizes', 'player_donation', 'industry_job_tax', 'brokers_fee', 'test_zero');
insert into public.ledger_ref_type (ref_type, account_in, account_out, transfer, verified, note) values
  ('bounty_prizes', '4300', null, false, true, 'test'),
  ('player_donation', '3100', '3100', true, true, 'test'),
  ('industry_job_tax', '4200', '5210', true, true, 'test'),
  ('brokers_fee', null, '5100', false, true, 'test'),
  ('test_zero', '4900', '5900', false, false, 'test');

insert into public.character_wallet_journal
  (registration_id, entry_id, date, ref_type, amount, balance, first_party_id, second_party_id)
values
  -- a1: a bounty (in), a broker fee (out), an unmapped ref_type, a zero row,
  -- and a null amount.
  ('00000000-0000-0000-0000-0000000000a1', 1, '2026-10-02 10:00Z', 'bounty_prizes',    100.00,  100.00, 1000125, 9001),
  ('00000000-0000-0000-0000-0000000000a1', 2, '2026-10-03 10:00Z', 'brokers_fee',      -10.00,   90.00, 9001, 1000132),
  ('00000000-0000-0000-0000-0000000000a1', 3, '2026-10-04 10:00Z', 'no_such_ref_type',   5.00,   95.00, 1, 9001),
  ('00000000-0000-0000-0000-0000000000a1', 4, '2026-10-05 10:00Z', 'test_zero',           0.00,   95.00, 9001, 9001),
  ('00000000-0000-0000-0000-0000000000a1', 5, '2026-10-06 10:00Z', 'bounty_prizes',      null,    null, 1000125, 9001),
  -- a1 → a2 donation, both sides on entry 10: internal and paired.
  ('00000000-0000-0000-0000-0000000000a1', 10, '2026-10-10 10:00Z', 'player_donation', -50.00,   45.00, 9001, 9002),
  ('00000000-0000-0000-0000-0000000000a2', 10, '2026-10-10 10:00Z', 'player_donation',  50.00,   50.00, 9001, 9002),
  -- a1 pays facility tax to the corporation it directs (entry 11): paired
  -- with the corporation's row below.
  ('00000000-0000-0000-0000-0000000000a1', 11, '2026-11-02 10:00Z', 'industry_job_tax', -20.00,   25.00, 9001, 98000001),
  -- a2 → a1 donation whose other side is missing (entry 12): unpaired.
  ('00000000-0000-0000-0000-0000000000a2', 12, '2026-11-03 10:00Z', 'player_donation',  -7.00,   43.00, 9002, 9001),
  -- a2 donates to a stranger: a transfer, but not internal.
  ('00000000-0000-0000-0000-0000000000a2', 13, '2026-11-04 10:00Z', 'player_donation',  -3.00,   40.00, 9002, 5555),
  -- b1's own row.
  ('00000000-0000-0000-0000-0000000000b1', 20, '2026-10-02 10:00Z', 'bounty_prizes',     9.00,    9.00, 1000125, 9101);

insert into public.corp_wallet_journal
  (corporation_id, division, entry_id, date, ref_type, amount, balance, first_party_id, second_party_id)
values
  (98000001, 1, 11, '2026-11-02 10:00Z', 'industry_job_tax', 20.00, 1020.00, 9001, 98000001),
  -- The corporation's tax to itself (stage 1 hidden credit): internal, paired.
  (98000001, 1, 30, '2026-11-05 10:00Z', 'industry_job_tax', -4.00, 1016.00, 98000001, 98000001),
  -- A row outside the window.
  (98000001, 2, 31, '2025-01-05 10:00Z', 'bounty_prizes',     1.00,    1.00, 1000125, 98000001);

-- Stage 1 evidence: a1 has a break inside November (two segments), a2 and
-- the corporation division one segment each. The newest check of a2 failed.
insert into public.ledger_wallet_segment
  (registration_id, corporation_id, division, first_entry_id, last_entry_id, first_date, last_date,
   opening, closing, row_count)
values
  ('00000000-0000-0000-0000-0000000000a1', null, null, 1, 10, '2026-10-02 10:00Z', '2026-10-10 10:00Z', 0, 45, 5),
  ('00000000-0000-0000-0000-0000000000a1', null, null, 11, 11, '2026-11-02 10:00Z', '2026-11-02 10:00Z', 45, 25, 1),
  ('00000000-0000-0000-0000-0000000000a2', null, null, 10, 13, '2026-10-10 10:00Z', '2026-11-04 10:00Z', 0, 40, 3),
  (null, 98000001, 1, 11, 30, '2026-11-02 10:00Z', '2026-11-05 10:00Z', 1000, 1016, 2);
insert into public.ledger_check
  (registration_id, corporation_id, division, checked_at, ok, segments, new_breaks, rows_read)
values
  ('00000000-0000-0000-0000-0000000000a1', null, null, '2026-11-20', true, 2, 0, 6),
  ('00000000-0000-0000-0000-0000000000a2', null, null, '2026-11-19', true, 1, 0, 3),
  ('00000000-0000-0000-0000-0000000000a2', null, null, '2026-11-20', false, 1, 1, 3),
  (null, 98000001, 1, '2026-11-20', true, 1, 0, 2);

-- A helper: fail with a message unless the condition holds.
create or replace function pg_temp.check(ok boolean, message text) returns void
language plpgsql as $$ begin if not coalesce(ok, false) then raise exception 'FAILED: %', message; end if; end $$;

-- ── The seeds ─────────────────────────────────────────────────────────────
select pg_temp.check((select count(*) from public.ledger_account) >= 29, 'the chart is seeded');
select pg_temp.check(
  (select count(*) from public.ledger_ref_type t
   where (t.account_in is not null and t.account_in not in (select code from public.ledger_account))
      or (t.account_out is not null and t.account_out not in (select code from public.ledger_account))) = 0,
  'every mapped account is in the chart');

-- ── I-4 and I-5 (as the table owner, who reads every row) ─────────────────
select pg_temp.check(
  (select count(*) from public.ledger_cash_line)
    = 2 * ((select count(*) from public.character_wallet_journal where amount is not null)
         + (select count(*) from public.corp_wallet_journal where amount is not null)),
  'I-5: two lines for each journal row with an amount');
select pg_temp.check(
  (select count(*) from public.ledger_cash_line where entry_id = 5) = 0,
  'I-5: a null amount gives no line');
select pg_temp.check(
  (select count(*) from (
     select wallet_key, entry_id from public.ledger_cash_line
     group by wallet_key, entry_id having sum(amount) <> 0 or count(*) <> 2) x) = 0,
  'I-4: the two lines of each row sum to zero');
select pg_temp.check(
  (select count(*) from (
     select wallet_key, entry_id from public.ledger_cash_line
     group by wallet_key, entry_id
     having count(*) filter (where side = 'cash') <> 1 or count(*) filter (where side = 'other') <> 1) x) = 0,
  'I-5: one cash line and one other line');
select pg_temp.check(
  (select account_code from public.ledger_cash_line where entry_id = 1 and side = 'other') = '4300'
  and (select amount from public.ledger_cash_line where entry_id = 1 and side = 'other') = -100.00
  and (select amount from public.ledger_cash_line where entry_id = 1 and side = 'cash') = 100.00
  and (select account_code from public.ledger_cash_line where entry_id = 1 and side = 'cash') = '1000',
  'income: +amount on 1000, −amount on account_in');
select pg_temp.check(
  (select account_code from public.ledger_cash_line where entry_id = 2 and side = 'other') = '5100',
  'an outflow goes to account_out');
select pg_temp.check(
  (select account_code from public.ledger_cash_line where entry_id = 3 and side = 'other') = '9000',
  'an unmapped ref_type goes to 9000');
select pg_temp.check(
  (select account_code from public.ledger_cash_line where entry_id = 4 and side = 'other') = '4900',
  'a zero row uses account_in');
select pg_temp.check(
  (select account_code from public.ledger_cash_line
   where entry_id = 30 and side = 'other') = '5210'
  and (select account_code from public.ledger_cash_line
       where entry_id = 30 and side = 'cash') = '1010'
  and (select wallet_key from public.ledger_cash_line where entry_id = 30 limit 1) = '98000001:1',
  'a corporation division: cash on 1010, the wallet key of stage 1');

-- ── As account A, the director ────────────────────────────────────────────
set local role authenticated;
select set_config('test.uid', '00000000-0000-0000-0000-00000000000a', true);

select pg_temp.check((select count(*) from public.ledger_group()) = 3, 'A: two characters and one corporation');
select pg_temp.check(
  (select count(*) from public.ledger_group() where corporation_id = 98000001) = 1
  and (select count(*) from public.ledger_group() where corporation_id = 98000777) = 0,
  'A: the directed corporation is in the group; a corporation A left is not');

-- The group statement for October and November.
create temp table s_group on commit drop as
  select public.ledger_cash_statement('2026-10-01', '2026-12-01') as doc;
grant select on s_group to authenticated;

select pg_temp.check((select doc->'window'->>'from' from s_group) = '2026-10-01'
  and (select doc->'window'->>'to' from s_group) = '2026-12-01'
  and (select doc->>'scope' from s_group) = 'group', 'the window and the scope');
select pg_temp.check(
  (select json_agg(m->>'month' order by m->>'month')::text from s_group, json_array_elements(doc->'months') m)
    = '["2026-10", "2026-11"]',
  'one entry for each UTC month');
select pg_temp.check(
  (select json_agg(w->>'wallet_key' order by w->>'wallet_key')::text from s_group, json_array_elements(doc->'wallets') w)
    = '["00000000-0000-0000-0000-0000000000a1", "00000000-0000-0000-0000-0000000000a2", "98000001:1"]',
  'the wallets: both characters and the one division with rows (division 2 has none in the window)');

-- October: bounty 100 (4300 −100), fee 10 (5100 +10), unmapped 5 (9000 −5),
-- zero row (4900 0). The a1↔a2 donation is internal and left out.
select pg_temp.check(
  (select json_agg(json_build_array(l->>'account_code', l->>'amount', (l->>'rows')::int) order by l->>'account_code')::text
   from s_group, json_array_elements(doc->'months') m, json_array_elements(m->'lines') l
   where m->>'month' = '2026-10')
    = '[["4300", "-100.00", 1], ["4900", "0.00", 1], ["5100", "10.00", 1], ["9000", "-5.00", 1]]',
  'October lines, internal donation left out');
select pg_temp.check(
  (select m->>'isk_moved' from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = '115.00'
  and (select m->>'suspense_isk' from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = '5.00'
  and (select (m->>'internal_rows')::int from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = 2
  and (select m->>'internal_isk' from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = '100.00'
  and (select (m->>'unpaired_transfers')::int from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = 0,
  'October totals');
-- October is not proven: a2's newest check failed (and a1's first segment
-- ends inside October at a break).
select pg_temp.check(
  (select (m->>'proven')::boolean from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10') = false
  and (select (m->'not_proven')::text from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-10')
    = '["break","check_failed"]',
  'October: the reasons');

-- November: the tax a1 → corporation is internal and paired; the corporation's
-- tax to itself is internal and paired by its hidden credit; the a2 → a1
-- donation has no other side; the donation to a stranger is kept.
select pg_temp.check(
  (select json_agg(json_build_array(l->>'account_code', l->>'amount') order by l->>'account_code')::text
   from s_group, json_array_elements(doc->'months') m, json_array_elements(m->'lines') l
   where m->>'month' = '2026-11')
    = '[["3100", "3.00"]]',
  'November lines: only the donation to a stranger');
select pg_temp.check(
  (select (m->>'internal_rows')::int from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-11') = 4
  and (select (m->>'unpaired_transfers')::int from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-11') = 1
  and (select (m->'not_proven')::text from s_group, json_array_elements(doc->'months') m where m->>'month' = '2026-11')
    = '["break","check_failed","unpaired_transfer"]',
  'November: four internal rows, one unpaired, and the reasons');
select pg_temp.check(
  (select json_array_length(doc->'unpaired') from s_group) = 1
  and (select doc->'unpaired'->0->>'wallet_key' from s_group) = '00000000-0000-0000-0000-0000000000a2'
  and (select doc->'unpaired'->0->>'amount' from s_group) = '-7.00'
  and (select (doc->'unpaired'->0->>'other_party_id')::bigint from s_group) = 9001,
  'the unpaired list');
select pg_temp.check(
  (select doc->'suspense'::text from s_group) is not null
  and (select json_array_length(doc->'suspense') from s_group) = 1
  and (select doc->'suspense'->0->>'ref_type' from s_group) = 'no_such_ref_type'
  and (select doc->'suspense'->0->>'isk_in' from s_group) = '5.00'
  and (select doc->'suspense'->0->>'isk_out' from s_group) = '0.00',
  'the Suspense list');

-- One wallet keeps all its rows, the internal ones too.
select pg_temp.check(
  (select json_agg(json_build_array(l->>'account_code', l->>'amount') order by l->>'account_code')::text
   from json_array_elements(public.ledger_cash_statement('2026-11-01', '2026-12-01', 'wallet', '98000001:1')->'months') m,
        json_array_elements(m->'lines') l)
    = '[["4200", "-20.00"], ["5210", "4.00"]]',
  'wallet scope keeps the internal rows');
select pg_temp.check(
  (public.ledger_cash_statement('2026-11-01', '2026-12-01', 'wallet', '98000001:1')->'months'->0->>'proven')::boolean,
  'the corporation division is proven in November');

-- The window rules.
do $$
begin
  begin
    perform public.ledger_cash_statement('2026-01-01', '2027-01-03');
    raise exception 'FAILED: a window over 366 days was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.ledger_cash_statement('2026-11-01', '2026-11-01');
    raise exception 'FAILED: an empty window was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.ledger_cash_statement('2026-11-01', '2026-12-01', 'everything');
    raise exception 'FAILED: an unknown scope was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.ledger_cash_statement('2026-11-01', '2026-12-01', 'wallet', '98000777:1');
    raise exception 'FAILED: a wallet outside the group was accepted';
  exception when insufficient_privilege then null;
  end;
end $$;
select pg_temp.check(
  (select json_array_length(public.ledger_cash_statement('2025-12-01', '2026-12-01')->'months')) = 12,
  'a 366-day window is accepted');

-- ── I-11: account B, a member who is not a director ──────────────────────
select set_config('test.uid', '00000000-0000-0000-0000-00000000000b', true);
select pg_temp.check(
  (select count(*) from public.ledger_group()) = 1
  and (select count(*) from public.ledger_group() where corporation_id is not null) = 0,
  'I-11: a member who is not a director gets no corporation in the group');
select pg_temp.check(
  (select json_agg(w->>'wallet_key')::text
   from json_array_elements(public.ledger_cash_statement('2026-10-01', '2026-12-01')->'wallets') w)
    = '["00000000-0000-0000-0000-0000000000b1"]',
  'I-11: B''s statement has B''s wallet only');
select pg_temp.check(
  (select count(*) from public.ledger_cash_line where registration_id is not null
     and registration_id <> '00000000-0000-0000-0000-0000000000b1') = 0,
  'I-11: B reads no line of A''s characters');
do $$
begin
  perform public.ledger_cash_statement('2026-11-01', '2026-12-01', 'wallet', '98000001:1');
  raise exception 'FAILED: a member read a corporation wallet through the statement';
exception when insufficient_privilege then null;
end $$;

-- ── I-11: account C, the outsider ─────────────────────────────────────────
select set_config('test.uid', '00000000-0000-0000-0000-00000000000c', true);
select pg_temp.check((select count(*) from public.ledger_cash_line) = 0, 'I-11: the outsider reads zero lines');
select pg_temp.check((select count(*) from public.ledger_group()) = 0, 'I-11: the outsider has no group');
select pg_temp.check(
  (select json_array_length(doc->'wallets') = 0
          and json_array_length(doc->'suspense') = 0
          and json_array_length(doc->'unpaired') = 0
          and (select count(*) from json_array_elements(doc->'months') m where json_array_length(m->'lines') > 0) = 0
   from (select public.ledger_cash_statement('2026-10-01', '2026-12-01') as doc) x),
  'I-11: the outsider gets an empty statement');
select pg_temp.check((select count(*) from public.ledger_account) > 0, 'a member reads the chart');

-- ── anon reads nothing ────────────────────────────────────────────────────
reset role;
select pg_temp.check(not has_table_privilege('anon', 'public.ledger_account', 'select'), 'anon: no ledger_account');
select pg_temp.check(not has_table_privilege('anon', 'public.ledger_ref_type', 'select'), 'anon: no ledger_ref_type');
select pg_temp.check(not has_table_privilege('anon', 'public.ledger_cash_line', 'select'), 'anon: no ledger_cash_line');
select pg_temp.check(not has_function_privilege('anon', 'public.ledger_group()', 'execute'), 'anon: no ledger_group');
select pg_temp.check(
  not has_function_privilege('anon', 'public.ledger_cash_statement(date, date, text, text)', 'execute'),
  'anon: no ledger_cash_statement');
select pg_temp.check(
  not has_table_privilege('authenticated', 'public.ledger_ref_type', 'insert')
  and not has_table_privilege('authenticated', 'public.ledger_account', 'update'),
  'authenticated cannot change the seeds');

-- ── The rollback ──────────────────────────────────────────────────────────
\ir ../../docs/ledger/rollback-stage-2.sql
select pg_temp.check(to_regclass('public.ledger_account') is null, 'rollback drops ledger_account');
select pg_temp.check(to_regclass('public.ledger_ref_type') is null, 'rollback drops ledger_ref_type');
select pg_temp.check(to_regclass('public.ledger_cash_line') is null, 'rollback drops ledger_cash_line');
select pg_temp.check(to_regprocedure('public.ledger_group()') is null, 'rollback drops ledger_group');
select pg_temp.check(
  to_regprocedure('public.ledger_cash_statement(date, date, text, text)') is null,
  'rollback drops ledger_cash_statement');
select pg_temp.check(
  (select count(*) from public.character_wallet_journal) = 11
  and (select count(*) from public.corp_wallet_journal) = 3
  and to_regclass('public.ledger_wallet_segment') is not null
  and to_regclass('public.ledger_check') is not null,
  'rollback leaves the source tables and stage 1 alone');

\echo 'ledger_cash: all checks passed'
rollback;
