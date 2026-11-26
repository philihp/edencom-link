-- Ledger stage 2: the lab measurements (docs/ledger/stage-2.md "Checks").
-- Run by `pnpm run ledger-lab-stage2 -- measure` on the stage 2 lab database
-- (src/ledger/labStage2.ts). It only reads. The figures are totals and
-- counts; no name is printed. `:lab_uid` is the lab account.
\pset footer off
\timing off

\echo '── Size'
select
  (select count(*) from public.character_wallet_journal) as character_rows,
  (select count(*) from public.corp_wallet_journal) as corporation_rows,
  (select count(*) from public.character_wallet_journal where amount is null)
    + (select count(*) from public.corp_wallet_journal where amount is null) as null_amount_rows,
  (select count(distinct wallet_key) from public.ledger_cash_line) as wallets;

\echo '── I-4 and I-5: two lines a row, summing to zero'
select
  count(*) as lines,
  count(*) filter (where side = 'cash') as cash_lines,
  count(*) filter (where side = 'other') as other_lines,
  (select count(*) from (
     select wallet_key, entry_id from public.ledger_cash_line
     group by 1, 2 having sum(amount) <> 0 or count(*) <> 2) x) as rows_not_two_or_not_zero
from public.ledger_cash_line;

\echo '── I-3: each stage 1 segment, cash lines + hidden credits + rounding = closing − opening'
-- For a segment: unexplained = closing − opening − Σ cash lines − hidden
-- credits taken. The chain lets in only two things that have no line:
-- one-cent rounding steps (at most rounding_steps cents in total) and hidden
-- credits (each self-paid industry_job_tax row of the segment gives its tax
-- back, less the credits still pending at the segment's end). The sums are
-- running sums over each wallet in entry id order, read once.
create temp table i3 as
with cash as (
  select wallet_key, entry_id,
         sum(amount) over w as cash_to,
         sum(case when ref_type = 'industry_job_tax' and amount < 0 and first_party_id = second_party_id
                  then -amount else 0 end) over w as credits_to
  from public.ledger_cash_line
  where side = 'cash'
  window w as (partition by wallet_key order by entry_id)
),
seg as (
  select s.*,
         case when s.registration_id is null then 'corporation' else 'character' end as kind,
         l.cash_to - f.cash_to + (select amount from public.ledger_cash_line x
                                  where x.side = 'cash' and x.wallet_key = s.wallet_key and x.entry_id = s.first_entry_id
                                    and (x.registration_id = s.registration_id or x.corporation_id = s.corporation_id)
                                  limit 1) as cash,
         l.credits_to - f.credits_to as credits_after_first,
         (select coalesce(sum(p), 0) from unnest(s.pending_credits) p) as pending
  from public.ledger_wallet_segment s
  join cash f on f.wallet_key = s.wallet_key and f.entry_id = s.first_entry_id
  join cash l on l.wallet_key = s.wallet_key and l.entry_id = s.last_entry_id
)
select seg.*,
       -- The first row's own credit counts too (it is due from the start).
       closing - opening - cash
         - (credits_after_first + (select coalesce(sum(-x.amount), 0) from public.ledger_cash_line x
                                   where x.side = 'cash' and x.wallet_key = seg.wallet_key and x.entry_id = seg.first_entry_id
                                     and (x.registration_id = seg.registration_id or x.corporation_id = seg.corporation_id)
                                     and x.ref_type = 'industry_job_tax' and x.amount < 0
                                     and x.first_party_id = x.second_party_id)
            - pending) as unexplained,
       credits_after_first - pending as hidden_isk
from seg;

select
  count(*) as segments,
  count(*) filter (where abs(unexplained) <= rounding_steps * 0.01) as proven,
  count(*) filter (where abs(unexplained) > rounding_steps * 0.01) as not_proven,
  sum(hidden_isk) as hidden_credits_isk,
  sum(unexplained) as rounding_isk,
  sum(rounding_steps) as rounding_steps,
  sum(hidden_credit_steps) as hidden_credit_steps
from i3;

\echo '── I-3 by wallet kind'
select kind, count(*) as segments,
       count(*) filter (where abs(unexplained) <= rounding_steps * 0.01) as proven,
       sum(row_count) as rows, sum(hidden_credit_steps) as hidden_credit_steps
from i3 group by kind order by kind;

\echo '── I-5: the Suspense share of ISK moved, every wallet, all history'
select
  sum(abs(amount)) as isk_moved,
  sum(abs(amount)) filter (where account_code = '9000') as suspense_isk,
  round(100 * coalesce(sum(abs(amount)) filter (where account_code = '9000'), 0) / nullif(sum(abs(amount)), 0), 4)
    as suspense_percent,
  count(*) filter (where account_code = '9000') as suspense_rows
from public.ledger_cash_line
where side = 'other';

\echo '── Accounts, every wallet, all history (other lines)'
select account_code, count(*) as rows, sum(amount) as amount
from public.ledger_cash_line
where side = 'other'
group by 1 order by 1;

-- ── The group statement, as the lab account ──────────────────────────────
set role authenticated;
select set_config('lab.uid', :'lab_uid', false);

\echo '── The group'
select count(*) filter (where registration_id is not null) as characters,
       count(*) filter (where corporation_id is not null) as corporations
from public.ledger_group();

\echo '── I-7: unpaired internal transfers by ref_type, all history'
-- The rule of ledger_cash_statement(), over every row instead of a window.
with g as (select * from public.ledger_group()),
parties as (select coalesce(character_id, corporation_id) as id from g),
rows as (
  select l.*, coalesce(gc.character_id, l.corporation_id) as owner_id
  from public.ledger_cash_line l
  left join g gc on gc.registration_id = l.registration_id
  where l.side = 'other'
    and (l.registration_id in (select registration_id from g where registration_id is not null)
         or l.corporation_id in (select corporation_id from g where corporation_id is not null))
),
classed as (
  select r.*,
         case when r.first_party_id = r.owner_id then r.second_party_id else r.first_party_id end as other_party_id
  from rows r
),
sides as (
  select entry_id, amount, min(wallet_key) as first_wallet, max(wallet_key) as last_wallet
  from classed group by 1, 2
),
first_rows as (
  select corporation_id as id, min(date) as first_row from public.corp_wallet_journal group by 1
  union all
  select r.character_id, min(j.date) from public.character_wallet_journal j
  join public.registration r on r.id = j.registration_id group by 1
),
internal as (
  select c.*,
         c.ref_type = 'industry_job_tax' and c.amount > 0 and c.first_party_id = c.second_party_id as self_paid,
         coalesce(o.first_wallet <> c.wallet_key or o.last_wallet <> c.wallet_key, false) as paired,
         f.first_row as other_first_row
  from classed c
  left join sides o on o.entry_id = c.entry_id and o.amount = -c.amount
  left join first_rows f on f.id = c.other_party_id
  where c.transfer and c.other_party_id in (select id from parties)
)
select ref_type,
       count(*) as internal_rows,
       count(*) filter (where self_paid) as self_paid,
       count(*) filter (where paired and not self_paid) as paired,
       count(*) filter (where not paired and not self_paid) as unpaired,
       count(*) filter (where not paired and not self_paid and date < other_first_row) as unpaired_before_other_journal,
       count(*) filter (where not paired and not self_paid and other_first_row is null) as unpaired_other_has_no_journal,
       count(*) filter (where not paired and not self_paid and date >= other_first_row) as unpaired_after,
       sum(abs(amount)) filter (where not paired and not self_paid) as unpaired_isk
from internal
group by ref_type order by ref_type;

\echo '── The 12-month group statement (2025-12-01 to 2026-12-01), month by month'
select m->>'month' as month,
       m->>'isk_moved' as isk_moved,
       m->>'suspense_isk' as suspense_isk,
       (m->>'internal_rows')::int as internal_rows,
       m->>'internal_isk' as internal_isk,
       (m->>'unpaired_transfers')::int as unpaired,
       m->>'proven' as proven,
       m->'not_proven' as not_proven
from json_array_elements(public.ledger_cash_statement('2025-12-01', '2026-12-01')->'months') m;

\echo '── The same statement: the Suspense list'
select s->>'ref_type' as ref_type, s->>'rows' as rows, s->>'isk_in' as isk_in, s->>'isk_out' as isk_out
from json_array_elements(public.ledger_cash_statement('2025-12-01', '2026-12-01')->'suspense') s;

\echo '── Parallel run 1: account 4000 (group) against the /market sales rule, by month'
-- /market: sells (is_buy false) of character_wallet_transaction with
-- is_personal, and of corp_wallet_transaction; value = quantity × unit_price.
reset role;
with ledger as (
  select l->>'account_code' as code, m->>'month' as month, -(l->>'amount')::numeric as amount
  from json_array_elements((select public.ledger_cash_statement('2025-12-01', '2026-12-01')
                            from (select set_config('lab.uid', :'lab_uid', true)) x)->'months') m,
       json_array_elements(m->'lines') l
),
market as (
  select to_char(date at time zone 'utc', 'YYYY-MM') as month, sum(quantity * unit_price) as sales, count(*) as trades
  from (
    select date, quantity, unit_price from ledger_lab.character_wallet_transaction
    where not is_buy and is_personal and date >= '2025-12-01' and date < '2026-12-01'
    union all
    select date, quantity, unit_price from ledger_lab.corp_wallet_transaction
    where not is_buy and date >= '2025-12-01' and date < '2026-12-01'
  ) t group by 1
)
select coalesce(l.month, k.month) as month,
       coalesce(l.amount, 0) as ledger_4000,
       coalesce(k.sales, 0) as market_sales,
       coalesce(l.amount, 0) - coalesce(k.sales, 0) as difference,
       k.trades
from (select month, amount from ledger where code = '4000') l
full join market k on k.month = l.month
order by 1;

\echo '── Parallel run 1, cause: journal sells with no personal market sell, and the reverse'
select
  (select count(*) from public.character_wallet_journal j
   where j.ref_type = 'market_transaction' and j.date >= '2025-12-01' and j.date < '2026-12-01'
     and not exists (select 1 from ledger_lab.character_wallet_transaction t
                     where t.transaction_id = j.context_id and not t.is_buy and t.is_personal)) as journal_sells_not_on_market,
  (select coalesce(sum(j.amount), 0) from public.character_wallet_journal j
   where j.ref_type = 'market_transaction' and j.date >= '2025-12-01' and j.date < '2026-12-01'
     and not exists (select 1 from ledger_lab.character_wallet_transaction t
                     where t.transaction_id = j.context_id and not t.is_buy and t.is_personal)) as their_isk,
  (select count(*) from ledger_lab.character_wallet_transaction t
   where not t.is_buy and t.is_personal and t.date >= '2025-12-01' and t.date < '2026-12-01'
     and not exists (select 1 from public.character_wallet_journal j
                     where j.registration_id = t.registration_id and j.context_id = t.transaction_id
                       and j.ref_type = 'market_transaction')) as market_sells_not_in_journal;

\echo '── Parallel run 2: industry_job_tax income against the /structure/revenue rule'
-- /structure/revenue lists every corp_wallet_journal industry_job_tax row the
-- caller reads, by UTC day. Here: its incoming rows, summed by month, against
-- the 4200 lines of industry_job_tax in the group statement (which leaves out
-- the tax our own characters paid to our own corporation).
with revenue as (
  select to_char(date at time zone 'utc', 'YYYY-MM') as month,
         sum(amount) filter (where amount > 0) as income,
         count(*) filter (where amount > 0) as rows
  from public.corp_wallet_journal
  where ref_type = 'industry_job_tax' and date >= '2025-12-01' and date < '2026-12-01'
  group by 1
),
internal as (
  select to_char(k.date at time zone 'utc', 'YYYY-MM') as month, sum(k.amount) as isk, count(*) as rows
  from public.corp_wallet_journal k
  where k.ref_type = 'industry_job_tax' and k.amount > 0
    and k.date >= '2025-12-01' and k.date < '2026-12-01'
    and k.first_party_id in (select character_id from public.registration)
  group by 1
)
select r.month, r.income as revenue_page, r.rows,
       coalesce(i.isk, 0) as paid_by_own_characters,
       r.income - coalesce(i.isk, 0) as group_income
from revenue r left join internal i on i.month = r.month
order by 1;

\echo '── Parallel run 2: the group statement 4200 lines of industry_job_tax, by month'
select to_char(l.date at time zone 'utc', 'YYYY-MM') as month, -sum(l.amount) as income, count(*) as rows
from public.ledger_cash_line l
where l.side = 'other' and l.ref_type = 'industry_job_tax' and l.amount < 0 and l.corporation_id is not null
  and l.date >= '2025-12-01' and l.date < '2026-12-01'
  and not (l.first_party_id in (select character_id from public.registration))
group by 1 order by 1;

\echo '── Read time: the 12-month group statement, five runs, as the lab account'
set role authenticated;
select set_config('lab.uid', :'lab_uid', false);
\timing on
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
\timing off

\echo '── Read time: one wallet (the busiest character), 12 months'
\timing on
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01', 'wallet', (
  select registration_id::text from public.character_wallet_journal
  group by registration_id order by count(*) desc limit 1))::text) as json_bytes;
\timing off

\echo '── explain: the 12-month group statement (auto_explain of the inner query)'
reset role;
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_buffers = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_level = notice;
set client_min_messages = notice;
set role authenticated;
select length(public.ledger_cash_statement('2025-12-01', '2026-12-01')::text) as json_bytes;
reset role;
