// The ledger lab (docs/ledger/lab.md): the host guard that keeps lab scripts
// off production (guard C8), the CSV the copy writes, and the keyset paging
// that keeps the copy's load on production flat.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { csvCell, csvRows } from '../src/ledger/labCsv.ts'
import { assertLocal, isLocalUrl } from '../src/ledger/labGuard.ts'
import { DIVISIONS, TABLES, keysetAfter, loadScript, partitionsOf } from '../src/ledger/labSpec.ts'

test('the guard accepts a database on this computer', () => {
  assert.ok(isLocalUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres'))
  assert.ok(isLocalUrl('postgresql://postgres@localhost/lab'))
  assert.ok(isLocalUrl('postgresql://postgres@[::1]:5432/lab'))
  assert.ok(isLocalUrl('postgresql:///lab'))
  assert.ok(isLocalUrl('postgresql:///lab?host=/var/run/postgresql'))
})

test('the guard refuses everything else', () => {
  assert.equal(isLocalUrl('postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres'), false)
  assert.equal(isLocalUrl('postgresql://postgres:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres'), false)
  assert.equal(isLocalUrl('postgresql://localhost.evil.example/lab'), false)
  assert.equal(isLocalUrl('postgresql://127.0.0.2/lab'), false)
  assert.equal(isLocalUrl('postgresql:///lab?host=db.supabase.co'), false)
  assert.equal(isLocalUrl('host=localhost dbname=lab'), false)
  assert.equal(isLocalUrl(''), false)
  assert.equal(isLocalUrl(undefined), false)
})

test('a refusal names the host but not the password', () => {
  assert.throws(
    () => assertLocal('postgresql://postgres:s3cret@db.x.supabase.co:5432/postgres', 'LAB_DATABASE_URL'),
    (error: Error) => /db\.x\.supabase\.co/.test(error.message) && !/s3cret/.test(error.message)
  )
  assert.equal(assertLocal('postgresql://127.0.0.1/lab', 'x'), 'postgresql://127.0.0.1/lab')
})

test('CSV keeps null and the empty string apart', () => {
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(undefined), '')
  assert.equal(csvCell(''), '""')
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"')
  assert.equal(csvCell(12.5), '12.5')
  assert.equal(csvCell(false), 'false')
  assert.equal(csvCell({ a: [1, '"'] }), '"{""a"":[1,""\\""""]}"')
  assert.equal(csvRows(['b', 'a'], [{ a: 1, b: null }]), ',1\n')
})

test('each table is read per owner, a corporation journal per division', () => {
  const owners = { registrationIds: ['r1', 'r2'], corporationIds: [98000001] }
  const bySpec = Object.fromEntries(TABLES.map((spec) => [spec.table, partitionsOf(spec, owners)]))
  assert.deepEqual(bySpec.character_wallet_journal, [{ registration_id: 'r1' }, { registration_id: 'r2' }])
  assert.deepEqual(bySpec.corp_contract, [{ corporation_id: 98000001 }])
  assert.equal(bySpec.corp_wallet_journal.length, DIVISIONS.length)
  assert.deepEqual(bySpec.corp_wallet_journal[6], { corporation_id: 98000001, division: 7 })
})

test('each page starts after the last key seen', () => {
  assert.equal(keysetAfter(['entry_id'], null), null)
  assert.deepEqual(keysetAfter(['entry_id'], { entry_id: 42, amount: 1 }), { gt: ['entry_id', 42] })
  assert.deepEqual(keysetAfter(['contract_id', 'record_id'], { contract_id: 7, record_id: 3 }), {
    or: 'contract_id.gt.7,and(contract_id.eq.7,record_id.gt.3)',
  })
})

test('every table pages on keys it copies, and no table reads the free text', () => {
  TABLES.forEach((spec) => {
    if (spec.columns !== 'raw')
      spec.keys.forEach((key) => assert.ok(spec.columns.includes(key), `${spec.table}.${key}`))
    if (spec.columns !== 'raw') assert.ok(!spec.columns.includes('reason') && !spec.columns.includes('description'))
  })
})

test('the load script copies every file into the lab schema, quoted', () => {
  const script = loadScript("/tmp/it's here")
  assert.match(script, /^\\set ON_ERROR_STOP 1$/m)
  assert.match(
    script,
    /\\copy ledger_lab\.registration \(id, character_id, corporation_id, is_main\) from '\/tmp\/it''s here\/registration\.csv'/
  )
  assert.match(script, /\\copy ledger_lab\.raw_corp_contract \(doc\) from/)
  assert.equal(script.match(/\\copy /g)?.length, TABLES.length + 1)
})
