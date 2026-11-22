-- Ledger stage 2: the cash ledger and the group view (docs/ledger/plan.md
-- layers 1 and 2; docs/ledger/stage-2.md is the contract).
--
-- DO NOT MERGE BEFORE GATE 1. On merge day this file gets a new timestamp
-- from the clock (check-migrations.mjs refuses one older than main's newest).
--
-- Two small seed tables and three read-only objects. No row is stored except
-- the seeds, no job is added, and nothing here writes to a source table
-- (guard C1): the view and the two functions only read the journals.
--
--   ledger_account          the chart of accounts (src/ledger/chart.ts holds
--                           the same list; test/ledgerChart.test.ts proves it)
--   ledger_ref_type         the account on the other side of each journal
--                           ref_type, by the sign of the amount
--   ledger_cash_line        two lines for each journal row (view)
--   ledger_group()          the caller's group: own characters, and the
--                           corporations the caller directs
--   ledger_cash_statement() the P&L by UTC month as one JSON document
--
-- RLS: the seed tables are readable by `authenticated`, not by `anon` (C4).
-- The view and the functions run with the caller's rights, so the journals'
-- own policies decide what a caller reads.
--
-- Rollback: docs/ledger/rollback-stage-2.sql (tested in test/sql/ledger_cash.sql).

-- ── ledger_account ────────────────────────────────────────────────────────
create table public.ledger_account (
  code text primary key check (code ~ '^[0-9]{4}$'),
  name text not null,
  kind text not null check (kind in ('asset', 'liability', 'equity', 'revenue', 'expense')),
  parent_code text references public.ledger_account (code)
);

alter table public.ledger_account enable row level security;
create policy "Members read the chart of accounts"
  on public.ledger_account
  for select
  to authenticated
  using (true);

grant select on public.ledger_account to authenticated;
grant all    on public.ledger_account to service_role;

-- The seed. Keep it in step with schema.sql and src/ledger/chart.ts.
-- @ledger_account_seed
insert into public.ledger_account (code, name, kind, parent_code) values
  ('1000', 'Cash', 'asset', null),
  ('1010', 'Cash: corporation division', 'asset', '1000'),
  ('1100', 'Market escrow', 'asset', null),
  ('1200', 'Inventory', 'asset', null),
  ('1210', 'Inventory: work in progress', 'asset', '1200'),
  ('1300', 'Contract collateral held', 'asset', null),
  ('1400', 'Receivables', 'asset', null),
  ('2000', 'Payables', 'liability', null),
  ('2100', 'Contract collateral owed', 'liability', null),
  ('3000', 'Opening balance equity', 'equity', null),
  ('3100', 'Intercompany', 'equity', null),
  ('4000', 'Revenue: market sales', 'revenue', null),
  ('4100', 'Revenue: contract sales', 'revenue', null),
  ('4200', 'Revenue: services', 'revenue', null),
  ('4300', 'Revenue: bounties and loot', 'revenue', null),
  ('4400', 'Revenue: insurance', 'revenue', null),
  ('4900', 'Other income', 'revenue', null),
  ('5000', 'Cost of goods sold', 'expense', null),
  ('5100', 'Broker fees', 'expense', null),
  ('5110', 'Sales tax', 'expense', null),
  ('5120', 'Contract fees', 'expense', null),
  ('5200', 'Industry: install fees', 'expense', null),
  ('5210', 'Industry: facility tax', 'expense', null),
  ('5300', 'Structure fuel and services', 'expense', null),
  ('5400', 'Clones and medical', 'expense', null),
  ('5500', 'Office and rent', 'expense', null),
  ('5600', 'Transport and courier', 'expense', null),
  ('5900', 'Other expense', 'expense', null),
  ('9000', 'Suspense: unclassified', 'equity', null);
-- @end

-- ── ledger_ref_type ───────────────────────────────────────────────────────
-- One row for each ref_type the census found (H10). A ref_type with no row,
-- or a side with no account, goes to 9000 (Suspense). A row with amount 0
-- uses account_in. `transfer`: the row moves ISK between two parties, and can
-- be internal to a group. `verified`: stage 0 measured the behaviour.
create table public.ledger_ref_type (
  ref_type text primary key,
  account_in text references public.ledger_account (code),
  account_out text references public.ledger_account (code),
  transfer boolean not null default false,
  verified boolean not null default false,
  note text not null default ''
);

alter table public.ledger_ref_type enable row level security;
create policy "Members read the ref_type map"
  on public.ledger_ref_type
  for select
  to authenticated
  using (true);

grant select on public.ledger_ref_type to authenticated;
grant all    on public.ledger_ref_type to service_role;

-- The seed. Keep it in step with schema.sql and src/ledger/chart.ts.
-- @ledger_ref_type_seed
insert into public.ledger_ref_type (ref_type, account_in, account_out, transfer, verified, note) values
  ('player_donation', '4900', '5900', true, true, 'H4: both sides share the entry id. Internal ones are left out of the group.'),
  ('market_escrow', '1100', '1100', false, true, 'H6: a buy from a sell order, and a buy order placed; in is escrow returned.'),
  ('market_transaction', '4000', '1200', false, true, 'H6: a sale. No out row seen; it would be a purchase (inventory, stage 6).'),
  ('contract_price', '4100', '1200', true, true, 'H4: both sides share the entry id. Out buys items (inventory, stage 6).'),
  ('contract_price_payment_corp', '4100', '1200', false, false, 'A contract price paid to the character for the corporation; no pair seen.'),
  ('manufacturing', '5200', '5200', false, false, 'Job install fee.'),
  ('contract_reward_deposited', '5600', '5600', false, false, 'Courier reward put up by the issuer.'),
  ('contract_reward', '4200', '4200', false, false, 'Courier reward received.'),
  ('corporation_account_withdrawal', '4900', '5900', true, false, 'Corporation to character. Internal when the corporation is in the group.'),
  ('transaction_tax', '5110', '5110', false, false, 'Sales tax; one-cent rounding (H2).'),
  ('reaction', '5200', '5200', false, false, 'Job install fee.'),
  ('brokers_fee', '5100', '5100', false, false, 'No context id (H7).'),
  ('industry_job_tax', '4200', '5210', true, true, 'H4: character to corporation pairs on the entry id; a corporation paying itself has a hidden credit (stage 1).'),
  ('contract_reward_refund', '5600', '5600', false, false, 'Courier reward returned to the issuer.'),
  ('market_provider_tax', '5100', '5100', false, false, 'The structure owner share of the broker fee.'),
  ('researching_time_productivity', '5200', '5200', false, false, 'Job install fee.'),
  ('researching_material_productivity', '5200', '5200', false, false, 'Job install fee.'),
  ('copying', '5200', '5200', false, false, 'Job install fee.'),
  ('skill_purchase', '5900', '5900', false, false, 'Skill books from the NPC.'),
  ('researching_technology', '5200', '5200', false, false, 'Invention install fee.'),
  ('insurance', '4400', '5900', false, false, 'In: a payout. Out: a premium.'),
  ('contract_collateral_payout', '4900', '4900', false, false, 'Collateral kept from a failed courier.'),
  ('contract_collateral', '1300', '1300', false, false, 'Collateral put up as the hauler.'),
  ('reprocessing_tax', '5900', '5900', false, false, 'Reprocessing tax.'),
  ('contract_collateral_refund', '1300', '1300', false, false, 'Collateral returned to the hauler.'),
  ('planetary_export_tax', '5900', '5900', false, false, 'Planetary industry.'),
  ('player_trading', '4100', '1200', true, true, 'H4: both sides share the entry id. 28,795 rows are zero.'),
  ('contract_deposit', '1400', '1400', false, false, 'Contract deposit, returned by contract_deposit_refund.'),
  ('cosmetic_market_skin_transaction', '4900', '5900', false, false, 'SKIN market.'),
  ('contract_brokers_fee', '5120', '5120', false, false, 'Contract broker fee.'),
  ('planetary_construction', '5900', '5900', false, false, 'Planetary industry.'),
  ('contract_auction_bid', '1400', '1400', false, false, 'Bid held until the auction ends.'),
  ('bounty_prizes', '4300', '4300', false, true, 'H3: amount is already net of tax.'),
  ('contract_deposit_refund', '1400', '1400', false, false, 'Contract deposit returned.'),
  ('daily_goal_payouts', '4900', '4900', false, false, 'Daily goals.'),
  ('ess_escrow_transfer', '4300', '4300', false, false, 'ESS bounty share.'),
  ('office_rental_fee', '4200', '5500', false, false, 'In: an office rented to others. Out: our office.'),
  ('contract_sales_tax', '5110', '5110', false, false, 'Contract sales tax.'),
  ('planetary_import_tax', '5900', '5900', false, false, 'Planetary industry.'),
  ('corporate_reward_payout', '4900', '4900', false, false, 'Corporation project reward.'),
  ('project_payouts', '4900', '4900', false, false, 'Corporation project payout.'),
  ('freelance_jobs_reward_escrow', '1400', '1400', false, false, 'Freelance job reward held.'),
  ('asset_safety_recovery_tax', '5900', '5900', false, false, 'Asset safety.'),
  ('jump_clone_activation_fee', '4200', '5400', false, false, 'In: our clone bay. Out: a clone jump. No pair on the entry id.'),
  ('freelance_jobs_reward', '4200', '4200', false, false, 'Freelance job reward.'),
  ('structure_gate_jump', '5600', '5600', false, false, 'Ansiblex toll.'),
  ('jump_clone_installation_fee', '4200', '5400', false, false, 'In: our clone bay. Out: a clone installed.'),
  ('flux_ticket_sale', '5900', '5900', false, false, 'Flux tickets.'),
  ('freelance_jobs_broadcasting_fee', '5900', '5900', false, false, 'Freelance job fee.'),
  ('freelance_jobs_duration_fee', '5900', '5900', false, false, 'Freelance job fee.'),
  ('allignment_based_gate_toll', '5600', '5600', false, false, 'Gate toll (the ESI spelling).'),
  ('agent_mission_reward', '4300', '4300', false, false, 'Mission reward.'),
  ('agent_mission_time_bonus_reward', '4300', '4300', false, false, 'Mission bonus.'),
  ('air_career_program_reward', '4900', '4900', false, false, 'AIR career program.'),
  ('project_discovery_reward', '4900', '4900', false, false, 'Project Discovery.'),
  ('gm_cash_transfer', '4900', '5900', false, false, 'A transfer by a GM.'),
  ('contract_auction_bid_refund', '1400', '1400', false, false, 'Auction bid returned.'),
  ('achievement_milestone_reward', '4900', '4900', false, false, 'Achievement reward.'),
  ('cosmetic_market_skin_sale_broker_fee', '5100', '5100', false, false, 'SKIN market broker fee.'),
  ('repair_bill', '5900', '5900', false, false, 'Repair.'),
  ('cosmetic_market_skin_sale_tax', '5110', '5110', false, false, 'SKIN market sales tax.');
-- @end

-- ── ledger_cash_line ──────────────────────────────────────────────────────
-- Two lines for each journal row with an amount: the cash line (1000 for a
-- character, 1010 for a corporation division) at +amount, and the other line
-- at −amount on the account the ref_type map gives for the sign. Debit is
-- positive: income of 100 ISK is +100 on cash and −100 on revenue. A row with
-- a null amount gives no line (H2 found none).
--
-- No index is added. A read gives a wallet owner and a date window, so that
-- each branch uses character_wallet_journal_registration_id_date_idx or
-- corp_wallet_journal_corp_date_idx. Filter on registration_id or
-- corporation_id, not on wallet_key: wallet_key is an expression.
create view public.ledger_cash_line
with (security_invoker = true)
as
with journal as (
  select
    c.registration_id,
    null::bigint as corporation_id,
    null::smallint as division,
    c.registration_id::text as wallet_key,
    '1000'::text as cash_account,
    c.entry_id,
    c.date,
    c.ref_type,
    c.amount,
    c.first_party_id,
    c.second_party_id,
    c.context_id,
    c.context_id_type
  from public.character_wallet_journal c
  where c.amount is not null
  union all
  select
    null::uuid,
    k.corporation_id,
    k.division,
    k.corporation_id::text || ':' || k.division::text,
    '1010'::text,
    k.entry_id,
    k.date,
    k.ref_type,
    k.amount,
    k.first_party_id,
    k.second_party_id,
    k.context_id,
    k.context_id_type
  from public.corp_wallet_journal k
  where k.amount is not null
)
select
  j.registration_id,
  j.corporation_id,
  j.division,
  j.wallet_key,
  s.side,
  case
    when s.side = 'cash' then j.cash_account
    when j.amount >= 0 then coalesce(t.account_in, '9000')
    else coalesce(t.account_out, '9000')
  end as account_code,
  case when s.side = 'cash' then j.amount else -j.amount end as amount,
  j.entry_id,
  j.date,
  j.ref_type,
  coalesce(t.transfer, false) as transfer,
  coalesce(t.verified, false) as verified,
  j.first_party_id,
  j.second_party_id,
  j.context_id,
  j.context_id_type
from journal j
left join public.ledger_ref_type t on t.ref_type = j.ref_type
cross join (values ('cash'::text), ('other'::text)) as s (side);

grant select on public.ledger_cash_line to authenticated;
grant select on public.ledger_cash_line to service_role;

-- ── ledger_group() ────────────────────────────────────────────────────────
-- The caller's group: one row for each registration of the account
-- (registration_id, character_id), and one for each corporation the account
-- directs (corporation_id). The director proof is the one of
-- src/app/structure/directors.ts: a corp_job_access row for job
-- 'corp-structures', by a registration that is in that corporation today. A
-- corporation the caller is only a member of is not in the group (I-11).
create or replace function public.ledger_group()
returns table (registration_id uuid, character_id bigint, corporation_id bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.character_id, null::bigint
  from public.registration r
  where r.user_id = (select auth.uid())
  union all
  select distinct null::uuid, null::bigint, a.corporation_id
  from public.corp_job_access a
  join public.registration r on r.id = a.registration_id
  where a.job = 'corp-structures'
    and r.user_id = (select auth.uid())
    and r.corporation_id = a.corporation_id;
$$;

revoke execute on function public.ledger_group() from public, anon;
grant execute on function public.ledger_group() to authenticated, service_role;

-- ── ledger_cash_statement() ───────────────────────────────────────────────
-- The P&L of the caller's group, or of one wallet of it, by UTC month, as the
-- JSON document of docs/ledger/stage-2.md "The statement".
--
--   p_from  first day, included;  p_to  last day, not included;  at most 366 days.
--   p_scope 'group'   every wallet of ledger_group(), internal transfers left out
--           'wallet'  the one wallet p_wallet_key (it must be in the group), all rows kept
--
-- Internal: a `transfer` row whose other party (first_party_id or
-- second_party_id, the one that is not the wallet's owner) is a character or a
-- corporation of the group. Unpaired (I-7): an internal row with no row of
-- the opposite amount and the same entry id in another wallet of the group.
-- An industry_job_tax paid to oneself is paired by its hidden credit (stage 1,
-- rule 3), which has no journal row.
--
-- Proven: a month of a wallet is proven when no segment of the wallet starts
-- or ends inside the month (except at the wallet's first and last row), and
-- the newest ledger_check row of the wallet is ok. A month of the scope is
-- proven when each wallet is and no internal transfer is unpaired.
--
-- Reads only the window: the journals through their (owner, date) indexes,
-- the segments and the newest check of each wallet. Nothing sums all history.
create or replace function public.ledger_cash_statement(
  p_from date,
  p_to date,
  p_scope text default 'group',
  p_wallet_key text default null
)
returns json
language plpgsql
stable
security invoker
set search_path = public
-- Measured on the lab (docs/ledger/stage-2.md "Read time"): JIT compiled the
-- plan for 3.4 s of a 4.1 s read; without it the read is well under that.
set jit = off
as $$
declare
  v_regs uuid[];
  v_chars bigint[];
  v_corps bigint[];
  v_parties bigint[];
  v_result json;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    raise exception 'ledger_cash_statement: p_from must be before p_to' using errcode = '22023';
  end if;
  if p_to - p_from > 366 then
    raise exception 'ledger_cash_statement: the window is at most 366 days' using errcode = '22023';
  end if;
  if p_scope is null or p_scope not in ('group', 'wallet') then
    raise exception 'ledger_cash_statement: p_scope is group or wallet' using errcode = '22023';
  end if;
  if (p_scope = 'wallet') <> (p_wallet_key is not null) then
    raise exception 'ledger_cash_statement: p_wallet_key is given with the wallet scope, and only then'
      using errcode = '22023';
  end if;

  select
    coalesce(array_agg(g.registration_id order by g.registration_id) filter (where g.registration_id is not null), '{}'),
    coalesce(array_agg(g.character_id order by g.registration_id) filter (where g.registration_id is not null), '{}'),
    coalesce(array_agg(g.corporation_id) filter (where g.corporation_id is not null), '{}'),
    coalesce(array_agg(coalesce(g.character_id, g.corporation_id)), '{}')
  into v_regs, v_chars, v_corps, v_parties
  from public.ledger_group() g;

  if p_scope = 'wallet' and not (
    p_wallet_key = any (select r::text from unnest(v_regs) r)
    or exists (
      select 1
      from unnest(v_corps) c, generate_series(1, 7) d
      where p_wallet_key = c::text || ':' || d::text
    )
  ) then
    raise exception 'ledger_cash_statement: the wallet is not in your group' using errcode = '42501';
  end if;

  with
  -- The other side of every group row in the window, with what each row
  -- needs to know about itself. Two reads, so that each one names its owner
  -- column and the planner keeps the owner-date index. The owner of a
  -- character wallet is its character (v_chars runs beside v_regs).
  loaded as materialized (
    select x.*,
           x.transfer and x.other_party_id = any (v_parties) as internal,
           to_char(x.date at time zone 'utc', 'YYYY-MM') as month
    from (
      select l.registration_id, l.corporation_id, l.division, l.wallet_key, l.account_code,
             l.amount, l.entry_id, l.date, l.ref_type, l.transfer, l.first_party_id, l.second_party_id,
             case when l.first_party_id = v_chars[array_position(v_regs, l.registration_id)]
                  then l.second_party_id else l.first_party_id end as other_party_id
      from public.ledger_cash_line l
      where l.side = 'other'
        and l.registration_id = any (v_regs)
        and l.date >= p_from and l.date < p_to
      union all
      select l.registration_id, l.corporation_id, l.division, l.wallet_key, l.account_code,
             l.amount, l.entry_id, l.date, l.ref_type, l.transfer, l.first_party_id, l.second_party_id,
             case when l.first_party_id = l.corporation_id
                  then l.second_party_id else l.first_party_id end
      from public.ledger_cash_line l
      where l.side = 'other'
        and l.corporation_id = any (v_corps)
        and l.date >= p_from and l.date < p_to
    ) x
  ),
  -- The other side of each (entry id, amount): an internal row is paired
  -- when a row of the opposite amount and the same entry id is in another
  -- wallet. One hash join, not a probe per row. Only a transfer row can be
  -- the other side of a transfer.
  sides as (
    select l.entry_id, l.amount, min(l.wallet_key) as first_wallet, max(l.wallet_key) as last_wallet
    from loaded l
    where l.transfer
    group by l.entry_id, l.amount
  ),
  -- Every group row is paired first, and the scope is taken after: with the
  -- wallet filter in the same step the planner estimated a few rows and
  -- probed the pairs once per row (86 s on the lab).
  paired as materialized (
    select l.*,
           l.internal and not (
             -- The hidden credit rule of src/ledger/check.ts: an outgoing
             -- industry_job_tax row whose two parties are the same (the other
             -- line of an outgoing row is positive).
             (l.ref_type = 'industry_job_tax' and l.amount > 0 and l.first_party_id = l.second_party_id)
             or coalesce(o.first_wallet <> l.wallet_key or o.last_wallet <> l.wallet_key, false)
           ) as unpaired
    from loaded l
    left join sides o on o.entry_id = l.entry_id and o.amount = -l.amount
  ),
  scoped as materialized (
    select p.* from paired p where p_scope = 'group' or p.wallet_key = p_wallet_key
  ),
  -- The rows that make the P&L: in the group, internal transfers are left out.
  kept as (
    select * from scoped s where p_scope = 'wallet' or not s.internal
  ),
  months as (
    select to_char(m, 'YYYY-MM') as month,
           m::date as month_start,
           (m + interval '1 month')::date as month_end
    from generate_series(date_trunc('month', p_from::timestamp), (p_to - 1)::timestamp, interval '1 month') m
  ),
  -- The wallets of the scope: one wallet, or every group wallet with a row in
  -- the window or a stage 1 check (a division that never had a row is not a
  -- wallet, as in stage 1).
  checks as (
    select distinct on (c.wallet_key) c.wallet_key, c.ok
    from public.ledger_check c
    where c.registration_id = any (v_regs) or c.corporation_id = any (v_corps)
    order by c.wallet_key, c.checked_at desc
  ),
  wallets as (
    select distinct on (w.wallet_key) w.*
    from (
      select s.wallet_key, s.registration_id, s.corporation_id, s.division
      from scoped s
      group by s.wallet_key, s.registration_id, s.corporation_id, s.division
      union all
      select c.wallet_key, k.registration_id, k.corporation_id, k.division
      from checks c
      join lateral (
        select k.registration_id, k.corporation_id, k.division
        from public.ledger_check k
        where k.wallet_key = c.wallet_key
        limit 1
      ) k on true
      where p_scope = 'group' or c.wallet_key = p_wallet_key
      union all
      select p_wallet_key,
             case when p_wallet_key ~ ':' then null else p_wallet_key::uuid end,
             case when p_wallet_key ~ ':' then split_part(p_wallet_key, ':', 1)::bigint end,
             case when p_wallet_key ~ ':' then split_part(p_wallet_key, ':', 2)::smallint end
      where p_scope = 'wallet'
    ) w
    order by w.wallet_key
  ),
  bounds as (
    select s.wallet_key, min(s.first_entry_id) as first_entry_id, max(s.last_entry_id) as last_entry_id
    from public.ledger_wallet_segment s
    where s.wallet_key in (select wallet_key from wallets)
    group by s.wallet_key
  ),
  -- The reasons a month of a wallet is not proven.
  wallet_reasons as (
    select m.month, w.wallet_key, r.reason
    from months m
    cross join wallets w
    left join checks c on c.wallet_key = w.wallet_key
    cross join lateral (
      select 'no_check'::text as reason where c.wallet_key is null
      union all
      select 'check_failed' where c.wallet_key is not null and not c.ok
      union all
      select 'break'
      where exists (
        select 1
        from public.ledger_wallet_segment s
        join bounds b on b.wallet_key = s.wallet_key
        where s.wallet_key = w.wallet_key
          and (
            (s.first_entry_id <> b.first_entry_id
             and s.first_date >= m.month_start and s.first_date < m.month_end)
            or (s.last_entry_id <> b.last_entry_id
                and s.last_date >= m.month_start and s.last_date < m.month_end)
          )
      )
    ) r
  ),
  month_lines as (
    select k.month, k.account_code, sum(k.amount) as amount, count(*) as rows
    from kept k
    group by k.month, k.account_code
  ),
  month_totals as (
    select m.month,
           coalesce(sum(abs(k.amount)), 0) as isk_moved,
           coalesce(sum(abs(k.amount)) filter (where k.account_code = '9000'), 0) as suspense_isk
    from months m
    left join kept k on k.month = m.month
    group by m.month
  ),
  month_internal as (
    select m.month,
           count(s.*) filter (where s.internal) as internal_rows,
           coalesce(sum(abs(s.amount)) filter (where s.internal), 0) as internal_isk,
           count(s.*) filter (where s.unpaired) as unpaired_transfers
    from months m
    left join scoped s on s.month = m.month
    group by m.month
  ),
  month_reasons as (
    select m.month,
           array(
             select distinct x.reason
             from (
               select wr.reason from wallet_reasons wr where wr.month = m.month
               union all
               select 'unpaired_transfer' where i.unpaired_transfers > 0
             ) x
             order by x.reason
           ) as reasons
    from months m
    join month_internal i on i.month = m.month
  )
  select json_build_object(
    'window', json_build_object('from', p_from::text, 'to', p_to::text),
    'scope', p_scope,
    'wallets', coalesce((
      select json_agg(json_build_object(
               'wallet_key', w.wallet_key,
               'kind', case when w.registration_id is not null then 'character' else 'corporation' end,
               'registration_id', w.registration_id,
               'corporation_id', w.corporation_id,
               'division', w.division
             ) order by w.registration_id is null, w.wallet_key)
      from wallets w
    ), '[]'::json),
    'months', coalesce((
      select json_agg(json_build_object(
               'month', m.month,
               'lines', coalesce((
                 select json_agg(json_build_object(
                          'account_code', l.account_code,
                          'amount', l.amount::numeric(20, 2)::text,
                          'rows', l.rows
                        ) order by l.account_code)
                 from month_lines l
                 where l.month = m.month
               ), '[]'::json),
               'isk_moved', t.isk_moved::numeric(20, 2)::text,
               'suspense_isk', t.suspense_isk::numeric(20, 2)::text,
               'internal_rows', i.internal_rows,
               'internal_isk', i.internal_isk::numeric(20, 2)::text,
               'unpaired_transfers', i.unpaired_transfers,
               'proven', cardinality(r.reasons) = 0,
               'not_proven', to_json(r.reasons)
             ) order by m.month)
      from months m
      join month_totals t on t.month = m.month
      join month_internal i on i.month = m.month
      join month_reasons r on r.month = m.month
    ), '[]'::json),
    'suspense', coalesce((
      select json_agg(json_build_object(
               'ref_type', x.ref_type,
               'rows', x.rows,
               'isk_in', x.isk_in::numeric(20, 2)::text,
               'isk_out', x.isk_out::numeric(20, 2)::text
             ) order by x.isk_in + x.isk_out desc, x.ref_type)
      from (
        -- The other line is −amount: a cash inflow is a negative other line.
        select k.ref_type,
               count(*) as rows,
               coalesce(sum(-k.amount) filter (where k.amount < 0), 0) as isk_in,
               coalesce(sum(k.amount) filter (where k.amount > 0), 0) as isk_out
        from kept k
        where k.account_code = '9000'
        group by k.ref_type
      ) x
    ), '[]'::json),
    'unpaired', coalesce((
      select json_agg(json_build_object(
               'date', u.date,
               'wallet_key', u.wallet_key,
               'ref_type', u.ref_type,
               'amount', (-u.amount)::numeric(20, 2)::text,
               'other_party_id', u.other_party_id
             ) order by u.date, u.wallet_key, u.entry_id)
      from (
        select s.* from scoped s where s.unpaired order by s.date, s.wallet_key, s.entry_id limit 100
      ) u
    ), '[]'::json)
  )
  into v_result;

  return v_result;
end;
$$;

revoke execute on function public.ledger_cash_statement(date, date, text, text) from public, anon;
grant execute on function public.ledger_cash_statement(date, date, text, text) to authenticated, service_role;
