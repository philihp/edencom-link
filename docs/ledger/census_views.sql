-- The ledger census, as temporary views (docs/ledger/plan.md, stage 0 step 2).
--
-- Each view answers one question H1 to H11 of the plan. census.sql selects
-- them for a report; test/sql/ledger_census.sql checks them against a small
-- set of rows with known answers. The views read the tables the search_path
-- finds: the lab (`set search_path = ledger_lab`) or the stand-ins of a test.
-- They are TEMP views: they go away with the session and write nothing.
--
-- Never run this on production. It reads whole tables (guard C2 and C8);
-- `pnpm run ledger-lab -- census` checks the host first.
--
-- No view shows a name, and no view shows a character, registration or
-- corporation id: a wallet is a label `character #n` or `corporation #n`
-- (division d). The report can then go into docs/ledger/measurements.md.

-- ── The rows of both journals, one wallet at a time ─────────────────────────
-- A wallet is a character, or a division of a corporation. owner_id is the
-- EVE id of the entity that holds the wallet: the character, or the
-- corporation (for all its divisions).
create or replace temp view census_journal as
select
  'character'::text as wallet_kind,
  j.registration_id::text as wallet_key,
  r.character_id as owner_id,
  j.entry_id,
  j.date,
  j.ref_type,
  j.amount,
  j.balance,
  j.tax,
  j.first_party_id,
  j.second_party_id,
  j.context_id,
  j.context_id_type,
  j.seen_at
from character_wallet_journal j
left join registration r on r.id = j.registration_id
union all
select
  'corporation',
  j.corporation_id || ':' || j.division,
  j.corporation_id,
  j.entry_id,
  j.date,
  j.ref_type,
  j.amount,
  j.balance,
  j.tax,
  j.first_party_id,
  j.second_party_id,
  j.context_id,
  j.context_id_type,
  j.seen_at
from corp_wallet_journal j;

-- The anonymous label of each wallet.
create or replace temp view census_wallet as
select
  wallet_kind,
  wallet_key,
  wallet_kind || ' #' || dense_rank() over (partition by wallet_kind order by owner_id)
    || case when wallet_kind = 'corporation' then ' division ' || split_part(wallet_key, ':', 2) else '' end
    as wallet_label
from (select distinct wallet_kind, wallet_key, owner_id from census_journal) w;

-- ── Each row beside the row before it in its wallet (entry id order) ───────
-- chainable: the row has an amount and a balance.
-- holds: the row and the one before are chainable, and
--   balance(n) = balance(n-1) + amount(n).
-- starts_segment: a chainable row where the rule does not hold (the first row
--   of a wallet, the row after a gap, the row after an unchainable row).
-- mismatch: starts_segment where the row before WAS chainable: a gap in the
--   journal (the `mismatch` break of src/ledger/chain.ts).
create or replace temp view census_pair as
with ordered as (
  select
    j.*,
    row_number() over w as n,
    lag(j.entry_id) over w as prev_entry_id,
    lag(j.date) over w as prev_date,
    lag(j.amount) over w as prev_amount,
    lag(j.balance) over w as prev_balance
  from census_journal j
  window w as (partition by j.wallet_kind, j.wallet_key order by j.entry_id)
),
judged as (
  select
    o.*,
    (o.amount is not null and o.balance is not null) as chainable,
    (o.n > 1 and o.prev_amount is not null and o.prev_balance is not null) as prev_chainable
  from ordered o
)
select
  j.*,
  (j.chainable and j.prev_chainable and j.prev_balance + j.amount = j.balance) as holds,
  (j.chainable and not (j.prev_chainable and j.prev_balance + j.amount = j.balance)) as starts_segment,
  (j.chainable and j.prev_chainable and j.prev_balance + j.amount <> j.balance) as mismatch
from judged j;

-- ── Segments: longest runs where the rule holds (layer 0) ──────────────────
create or replace temp view census_segment as
with numbered as (
  select
    p.*,
    sum(p.starts_segment::int) over (
      partition by p.wallet_kind, p.wallet_key order by p.entry_id rows unbounded preceding
    ) as segment_no
  from census_pair p
)
select
  wallet_kind,
  wallet_key,
  segment_no,
  min(entry_id) as first_entry_id,
  max(entry_id) as last_entry_id,
  min(date) as first_date,
  max(date) as last_date,
  (array_agg(balance - amount order by entry_id))[1] as opening,
  (array_agg(balance order by entry_id desc))[1] as closing,
  sum(amount) as amount_sum,
  count(*) as rows
from numbered
where chainable
group by wallet_kind, wallet_key, segment_no;

-- ── H1: does entry id order equal time order in one wallet? ────────────────
create or replace temp view census_h1 as
select
  wallet_kind,
  count(distinct wallet_key) as wallets,
  count(*) filter (where n > 1) as adjacent_pairs,
  count(*) filter (where n > 1 and date < prev_date) as pairs_time_backwards,
  count(*) filter (where n > 1 and date = prev_date) as pairs_same_second,
  count(distinct wallet_key) filter (where n > 1 and date < prev_date) as wallets_time_backwards
from census_pair
group by wallet_kind;

-- ── H2: does the chain rule hold, per ref_type? Nulls? ─────────────────────
-- A fail is filed under the ref_type of the row AFTER the gap: the missing
-- rows themselves are not here to name.
create or replace temp view census_h2 as
select
  ref_type,
  count(*) as rows,
  count(*) filter (where amount is null) as null_amount,
  count(*) filter (where balance is null) as null_balance,
  count(*) filter (where chainable and prev_chainable) as chainable_pairs,
  count(*) filter (where holds) as holds,
  count(*) filter (where mismatch) as fails
from census_pair
group by ref_type
order by count(*) filter (where mismatch) desc, ref_type;

-- The same per wallet: the figure gate 0 tests (99% of adjacent pairs).
create or replace temp view census_h2_wallet as
select
  w.wallet_label,
  count(*) as rows,
  count(*) filter (where p.chainable and p.prev_chainable) as chainable_pairs,
  count(*) filter (where p.holds) as holds,
  count(*) filter (where p.mismatch) as fails,
  round(
    100.0 * count(*) filter (where p.holds)
      / nullif(count(*) filter (where p.chainable and p.prev_chainable), 0),
    3
  ) as hold_percent
from census_pair p
join census_wallet w using (wallet_kind, wallet_key)
group by w.wallet_label
order by w.wallet_label;

-- ── H3: what does `tax` mean? ──────────────────────────────────────────────
-- For each row with a tax, which form of the rule holds: the balance moves by
-- amount, by amount - tax, or by amount + tax.
create or replace temp view census_h3 as
select
  ref_type,
  count(*) as rows_with_tax,
  sum(tax) as tax_sum,
  count(*) filter (where prev_chainable and prev_balance + amount = balance) as moves_by_amount,
  count(*) filter (where prev_chainable and prev_balance + amount - tax = balance) as moves_by_amount_minus_tax,
  count(*) filter (where prev_chainable and prev_balance + amount + tax = balance) as moves_by_amount_plus_tax,
  count(*) filter (where not prev_chainable or balance is null or amount is null) as cannot_tell
from census_pair
where tax is not null and tax <> 0
group by ref_type
order by count(*) desc;

-- ── H4: internal transfers ─────────────────────────────────────────────────
-- Our entities: the characters of the account, and each corporation with a
-- journal here.
create or replace temp view census_our_entity as
select character_id as entity_id, 'character'::text as entity_kind from registration
union
select distinct corporation_id, 'corporation' from corp_wallet_journal;

-- The other party of a row: the party that is not the wallet's owner. A row
-- where both parties are the owner (a move between two divisions of one
-- corporation) has the owner as its counterparty.
create or replace temp view census_counterparty as
select
  j.*,
  case when j.first_party_id = j.owner_id then j.second_party_id else j.first_party_id end as counterparty_id
from census_journal j;

-- For each row whose counterparty is one of our entities: is the other side
-- in our journals, and under which entry id?
--   same_entry: a row of another of our wallets has the same entry id
--     and the opposite amount.
--   same_entry_other_amount: same entry id, but the amount is not opposite.
--   other_entry: no same entry id, but a row of the counterparty's wallets
--     has the opposite amount at the same second.
--   not_pulled: the counterparty has no journal here at all.
--   missing: none of these.
create or replace temp view census_h4_row as
select
  c.*,
  case
    when c.counterparty_id = c.owner_id then 'same_entity'
    when exists (
      select 1 from census_journal o
      where o.entry_id = c.entry_id
        and (o.wallet_kind, o.wallet_key) <> (c.wallet_kind, c.wallet_key)
        and o.amount = -c.amount
    ) then 'same_entry'
    when exists (
      select 1 from census_journal o
      where o.entry_id = c.entry_id
        and (o.wallet_kind, o.wallet_key) <> (c.wallet_kind, c.wallet_key)
    ) then 'same_entry_other_amount'
    when exists (
      select 1 from census_journal o
      where o.owner_id = c.counterparty_id
        and o.date = c.date
        and o.amount = -c.amount
    ) then 'other_entry'
    when not exists (select 1 from census_journal o where o.owner_id = c.counterparty_id) then 'not_pulled'
    else 'missing'
  end as pairing
from census_counterparty c
where c.counterparty_id in (select entity_id from census_our_entity);

create or replace temp view census_h4 as
select
  ref_type,
  pairing,
  count(*) as rows,
  sum(abs(amount)) as isk
from census_h4_row
group by ref_type, pairing
order by ref_type, pairing;

-- ── H5: one transaction_id for both sides of a trade? ──────────────────────
-- A market_transaction journal row names its transaction in context_id. When
-- that transaction is stored under ANOTHER wallet than the row's own, the two
-- sides share one transaction_id, and the key `transaction_id` alone kept
-- only one of them (first scanner wins).
create or replace temp view census_transaction as
select transaction_id, 'character'::text as wallet_kind, registration_id::text as wallet_key, is_buy, quantity, unit_price, journal_ref_id
from character_wallet_transaction
union all
select transaction_id, 'corporation', corporation_id || ':' || division, is_buy, quantity, unit_price, journal_ref_id
from corp_wallet_transaction;

create or replace temp view census_h5 as
select
  case
    when t.transaction_id is null then 'no_transaction_row'
    when (t.wallet_kind, t.wallet_key) = (c.wallet_kind, c.wallet_key) then 'stored_for_this_wallet'
    else 'stored_for_another_wallet'
  end as storage,
  (c.counterparty_id in (select entity_id from census_our_entity)) as counterparty_is_ours,
  count(*) as journal_rows,
  sum(abs(c.amount)) as isk
from census_counterparty c
left join census_transaction t on t.transaction_id = c.context_id
where c.ref_type = 'market_transaction' and c.context_id_type = 'market_transaction_id'
group by 1, 2
order by 1, 2;

-- The pairs of our own trades: two of our journal rows that name the same
-- transaction. If H5 is true, these exist and only one side has a row.
create or replace temp view census_h5_pair as
select
  count(*) as journal_pairs_naming_one_transaction
from census_journal a
join census_journal b
  on b.context_id = a.context_id
  and b.ref_type = 'market_transaction'
  and (b.wallet_kind, b.wallet_key) > (a.wallet_kind, a.wallet_key)
where a.ref_type = 'market_transaction' and a.context_id_type = 'market_transaction_id';

-- ── H6: amount = quantity × unit price? What does a buy post? ──────────────
-- Each transaction row joined to the journal row of its own wallet that
-- journal_ref_id names.
create or replace temp view census_h6 as
select
  case when t.is_buy then 'buy' else 'sell' end as side,
  case
    when j.entry_id is null then 'no_journal_row'
    when j.amount = case when t.is_buy then -1 else 1 end * t.quantity * t.unit_price then 'amount_is_signed_quantity_x_price'
    when abs(j.amount) = t.quantity * t.unit_price then 'amount_is_quantity_x_price_wrong_sign'
    when j.amount = 0 then 'amount_zero'
    else 'amount_differs'
  end as agreement,
  j.ref_type,
  count(*) as transactions,
  sum(t.quantity * t.unit_price) as isk
from census_transaction t
left join census_journal j
  on j.wallet_kind = t.wallet_kind and j.wallet_key = t.wallet_key and j.entry_id = t.journal_ref_id
group by 1, 2, 3
order by 1, 2, 3;

-- Do the two links agree? journal_ref_id → entry, and entry context_id → transaction.
create or replace temp view census_h6_link as
select
  count(*) as transactions,
  count(j.entry_id) as linked_by_journal_ref_id,
  count(*) filter (where j.context_id = t.transaction_id) as context_id_names_it_back
from census_transaction t
left join census_journal j
  on j.wallet_kind = t.wallet_kind and j.wallet_key = t.wallet_key and j.entry_id = t.journal_ref_id;

-- ── H7: which context_id_type for each ref_type? ───────────────────────────
create or replace temp view census_h7 as
select ref_type, coalesce(context_id_type, '(none)') as context_id_type, count(*) as rows
from census_journal
group by 1, 2
order by 1, 3 desc;

-- ── H8: do the imported rows chain? ────────────────────────────────────────
-- ESI keeps 30 days. A row first seen more than 31 days after its date can
-- only have come from the jEveAssets import (src/jobs/importJeveJournal.js).
create or replace temp view census_h8 as
select
  case when seen_at > date + interval '31 days' then 'imported' else 'extracted' end as source,
  count(*) as rows,
  min(date) as first_date,
  max(date) as last_date,
  count(*) filter (where amount is null or balance is null) as unchainable,
  count(*) filter (where chainable and prev_chainable) as chainable_pairs,
  count(*) filter (where holds) as holds,
  count(*) filter (where mismatch) as fails
from census_pair
group by 1
order by 1;

-- ── H9: do the wallet snapshots agree with the journal? ────────────────────
-- For each character_wallet snapshot: the balance of the newest journal row
-- at or before the snapshot. If they differ, the nearest row within an hour
-- whose balance before or after equals the snapshot, and how far away it is
-- (ESI caches the balance and the journal for different times).
create or replace temp view census_h9_row as
select
  s.registration_id,
  s.recorded_at,
  s.balance as snapshot,
  before.balance as journal_balance,
  near.offset_seconds
from character_wallet s
left join lateral (
  select j.balance
  from character_wallet_journal j
  where j.registration_id = s.registration_id and j.date <= s.recorded_at and j.balance is not null
  order by j.entry_id desc
  limit 1
) before on true
left join lateral (
  select abs(extract(epoch from (j.date - s.recorded_at))) as offset_seconds
  from character_wallet_journal j
  where j.registration_id = s.registration_id
    and j.date between s.recorded_at - interval '1 hour' and s.recorded_at + interval '1 hour'
    and (j.balance = s.balance or j.balance - j.amount = s.balance)
  order by abs(extract(epoch from (j.date - s.recorded_at)))
  limit 1
) near on true;

create or replace temp view census_h9 as
select
  case
    when journal_balance is null then 'no_journal_before'
    when journal_balance = snapshot then 'equal'
    when offset_seconds is not null then 'equal_within_1h'
    else 'differs'
  end as compare,
  count(*) as snapshots,
  percentile_disc(0.5) within group (order by offset_seconds) as median_offset_seconds,
  percentile_disc(0.95) within group (order by offset_seconds) as p95_offset_seconds,
  max(abs(snapshot - journal_balance)) as max_difference
from census_h9_row
group by 1
order by 1;

-- ── H10: which ref_types, which signs, how much? ───────────────────────────
create or replace temp view census_h10 as
select
  ref_type,
  wallet_kind,
  case when amount is null then 'null' when amount > 0 then 'in' when amount < 0 then 'out' else 'zero' end as direction,
  count(*) as rows,
  sum(abs(amount)) as isk
from census_journal
group by 1, 2, 3
order by sum(abs(amount)) desc nulls last, 1, 2, 3;

-- ── H11: sizes, and the segments of each wallet today ──────────────────────
-- Sizes are of the LAB tables: they hold one account's rows, not the whole
-- production table.
create or replace temp view census_h11_size as
select
  t as lab_table,
  pg_total_relation_size(to_regclass(t)) as bytes
from unnest(array[
  'registration',
  'character_wallet',
  'character_wallet_journal',
  'corp_wallet_journal',
  'character_wallet_transaction',
  'corp_wallet_transaction'
]) as t;

create or replace temp view census_h11_wallet as
select
  w.wallet_label,
  count(*) as segments,
  sum(s.rows) as chained_rows,
  min(s.first_date) as first_date,
  max(s.last_date) as last_date,
  -- the net ISK the gaps leave out: each segment's opening minus the closing
  -- of the segment before it.
  sum(abs(s.opening - s.prev_closing)) filter (where s.prev_closing is not null) as gap_isk
from (
  select seg.*, lag(seg.closing) over (partition by seg.wallet_kind, seg.wallet_key order by seg.first_entry_id) as prev_closing
  from census_segment seg
) s
join census_wallet w using (wallet_kind, wallet_key)
group by w.wallet_label
order by w.wallet_label;
