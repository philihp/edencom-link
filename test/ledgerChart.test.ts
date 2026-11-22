// The chart of accounts and the ref_type map (ledger stage 2): the pure
// module src/ledger/chart.ts must equal the seeds of the migration and of
// schema.sql, row for row.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

import { filter, map, pluck, uniq } from 'ramda'

import { ACCOUNTS, REF_TYPES, SUSPENSE, otherAccount } from '../src/ledger/chart.ts'

const migration = readdirSync('supabase/migrations').find((name) => name.endsWith('_ledger_cash.sql'))
const migrationText = readFileSync(`supabase/migrations/${migration}`, 'utf8')
const schemaText = readFileSync('schema.sql', 'utf8')

// The SQL between `-- @<marker>` and the next `-- @end`.
const block = (text: string, marker: string): string => {
  const start = text.indexOf(`-- @${marker}\n`)
  assert.notEqual(start, -1, `no -- @${marker}`)
  const end = text.indexOf('-- @end', start)
  return text.slice(start, end)
}

// One SQL value: a quoted string (with '' for a quote), null, true or false.
const VALUE = /'((?:[^']|'')*)'|(null|true|false)/g
const parseValue = (match: RegExpMatchArray): string | boolean | null => {
  if (match[1] !== undefined) return match[1].replace(/''/g, "'")
  if (match[2] === 'null') return null
  return match[2] === 'true'
}

// Each `  (…),` line of a values list, as its values.
const tuples = (sql: string): (string | boolean | null)[][] =>
  map(
    (line: string) => map(parseValue, [...line.matchAll(VALUE)]),
    filter((line: string) => line.startsWith('  ('), sql.split('\n'))
  )

const accountRows = map((a) => [a.code, a.name, a.kind, a.parent], ACCOUNTS)
const refTypeRows = map((r) => [r.refType, r.accountIn, r.accountOut, r.transfer, r.verified, r.note], REF_TYPES)

test('the migration seeds exactly the chart of chart.ts', () => {
  assert.deepEqual(tuples(block(migrationText, 'ledger_account_seed')), accountRows)
  assert.deepEqual(tuples(block(migrationText, 'ledger_ref_type_seed')), refTypeRows)
})

test('schema.sql seeds exactly the chart of chart.ts', () => {
  assert.deepEqual(tuples(block(schemaText, 'ledger_account_seed')), accountRows)
  assert.deepEqual(tuples(block(schemaText, 'ledger_ref_type_seed')), refTypeRows)
})

test('each code and each ref_type is listed once, and every mapped account exists', () => {
  const codes = pluck('code', ACCOUNTS)
  assert.equal(uniq(codes).length, codes.length)
  assert.equal(uniq(pluck('refType', REF_TYPES)).length, REF_TYPES.length)
  REF_TYPES.forEach((r) => {
    if (r.accountIn !== null) assert.ok(codes.includes(r.accountIn), `${r.refType} in`)
    if (r.accountOut !== null) assert.ok(codes.includes(r.accountOut), `${r.refType} out`)
  })
  ACCOUNTS.forEach((a) => {
    if (a.parent !== null) assert.ok(codes.includes(a.parent), `${a.code} parent`)
  })
})

test('the census found 61 ref_types (H10)', () => {
  assert.equal(REF_TYPES.length, 61)
})

test('the other account follows the sign, and Suspense takes the rest', () => {
  assert.equal(otherAccount('market_transaction', 100), '4000')
  assert.equal(otherAccount('industry_job_tax', -5), '5210')
  assert.equal(otherAccount('industry_job_tax', 5), '4200')
  assert.equal(otherAccount('player_trading', 0), '4100')
  assert.equal(otherAccount('no_such_ref_type', 1), SUSPENSE)
})
