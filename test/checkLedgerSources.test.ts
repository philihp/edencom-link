// Guard C1 of docs/ledger/plan.md (.github/scripts/check-ledger-sources.mjs):
// no ledger file writes to a wallet source table. The pattern is the guard,
// so it is the part worth testing.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isLedgerFile, writesToSources } from '../.github/scripts/check-ledger-sources.mjs'

const tableOf = (problems: string[]) => problems.map((p) => p.match(/source table (\w+)/)?.[1])

test('SQL writes to a source table are found', () => {
  const sql = [
    'insert into public.character_wallet_journal (entry_id) values (1);',
    'UPDATE corp_wallet_journal set amount = 0;',
    'delete from character_wallet_transaction where true;',
    'alter table if exists corp_wallet_transaction add column x int;',
    'drop table character_wallet;',
    'truncate table only character_wallet_journal;',
  ].join('\n')
  assert.deepEqual(tableOf(writesToSources('m.sql', sql)), [
    'character_wallet_journal',
    'corp_wallet_journal',
    'character_wallet_transaction',
    'corp_wallet_transaction',
    'character_wallet',
    'character_wallet_journal',
  ])
  assert.match(writesToSources('m.sql', sql)[1], /^m\.sql:2 /)
})

test('reads, lab copies and ledger tables are not writes to a source', () => {
  const sql = [
    'select * from character_wallet_journal;',
    'insert into ledger_lab.character_wallet_journal select 1;',
    'insert into ledger_check (wallet) select registration_id from character_wallet_journal;',
    'insert into corp_wallet (balance) values (1);',
    'create table ledger_lab.character_wallet (id uuid);',
    'update ledger_check set ok = true;',
  ].join('\n')
  assert.deepEqual(writesToSources('m.sql', sql), [])
})

test('supabase-js writes to a source table are found, reads are not', () => {
  const js = [
    "await db.from('character_wallet_journal').upsert(rows)",
    '',
    'await db\n  .from("corp_wallet_journal")\n  .delete()\n  .eq(\'corporation_id\', 1)',
    '',
    "await db.from('character_wallet_journal').select('*').order('entry_id')",
    '',
    "await db.from('ledger_check').insert(rows)",
  ].join('\n')
  assert.deepEqual(tableOf(writesToSources('a.ts', js)), ['character_wallet_journal', 'corp_wallet_journal'])
})

test('a write on a later statement does not count against an earlier read', () => {
  const js = "const rows = await db.from('character_wallet').select('*')\n\nawait db.from('ledger_check').insert(rows)"
  assert.deepEqual(writesToSources('a.ts', js), [])
})

test('only ledger files are scanned', () => {
  assert.ok(isLedgerFile('src/ledger/chain.ts'))
  assert.ok(isLedgerFile('docs/ledger/census_views.sql'))
  assert.ok(isLedgerFile('src/jobs/ledgerCheck.js'))
  assert.ok(isLedgerFile('src/workflows/ledgerCheck.ts'))
  assert.ok(isLedgerFile('supabase/migrations/20261118000000_ledger_check.sql'))
  assert.ok(isLedgerFile('src/app/ledger/health/page.tsx'))
  assert.equal(isLedgerFile('docs/ledger/plan.md'), false)
  assert.equal(isLedgerFile('src/jobs/characterWalletJournal.js'), false)
  assert.equal(isLedgerFile('test/sql/ledger_census.sql'), false)
})
