-- The ledger census report (docs/ledger/plan.md, stage 0 step 2).
--
--   pnpm run ledger-lab -- census > lab/census.txt
--
-- Runs on the LAB only: the runner checks that the database is on this
-- computer before psql starts, and sets search_path to ledger_lab. The
-- questions and their views are in census_views.sql. The output has labels,
-- not ids or names, so its totals can go into docs/ledger/measurements.md.
\set ON_ERROR_STOP 1
\pset footer off
\set QUIET on
\ir census_views.sql
\set QUIET off

\echo '== H1: entry id order against time order'
select * from census_h1;
\echo '== H2: the chain rule, by ref_type (a fail is filed under the row after the gap)'
select * from census_h2;
\echo '== H2: the chain rule, by wallet (gate 0: 99% of adjacent pairs)'
select * from census_h2_wallet;
\echo '== H3: rows with a tax, and how the balance moved'
select * from census_h3;
\echo '== H4: rows whose counterparty is one of our entities'
select * from census_h4;
\echo '== H5: market_transaction rows, and where their transaction is stored'
select * from census_h5;
select * from census_h5_pair;
\echo '== H6: transaction against journal amount'
select * from census_h6;
select * from census_h6_link;
\echo '== H7: context_id_type by ref_type'
select * from census_h7;
\echo '== H8: imported rows against extracted rows'
select * from census_h8;
\echo '== H9: wallet snapshots against the journal balance'
select * from census_h9;
\echo '== H10: ref_types, signs and ISK'
select * from census_h10;
\echo '== H11: lab table sizes'
select * from census_h11_size;
\echo '== H11: segments of each wallet'
select * from census_h11_wallet;
