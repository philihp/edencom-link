// Unit coverage for the pure half of the jEveAssets transaction backfill
// (src/jobs/jeveTransactions.js): the column translation back to ESI's names,
// both date forms, the XML export, and the one-registration rule.
import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeUtf16, parseXml, summarize, toIso, toRow, toRows } from '../src/jobs/jeveTransactions.js'

const sell = {
  transactionid: '6905589362',
  transactiondatetime: 1777700000000,
  typeid: '16273',
  quantity: '120',
  price: '1234.56',
  transactiontype: 'sell',
  transactionfor: 'personal',
  clientid: '90000001',
  stationid: '60003760',
  journaltransactionid: '22000000001',
}

test('toIso reads epoch milliseconds and the UTC text form', () => {
  assert.equal(toIso(0), '1970-01-01T00:00:00.000Z')
  assert.equal(toIso('1777700000000'), new Date(1777700000000).toISOString())
  assert.equal(toIso('2021-06-14 12:34:56'), '2021-06-14T12:34:56.000Z')
})

test('toRow translates jEveAssets columns back to ESI names', () => {
  assert.deepEqual(toRow('reg-1', sell), {
    transaction_id: 6905589362,
    registration_id: 'reg-1',
    date: new Date(1777700000000).toISOString(),
    type_id: 16273,
    quantity: 120,
    unit_price: 1234.56,
    is_buy: false,
    is_personal: true,
    client_id: 90000001,
    location_id: 60003760,
    journal_ref_id: 22000000001,
  })
})

test('toRow reads buy/corporate and a zero journal ref as null', () => {
  const row = toRow('reg-1', { ...sell, transactiontype: 'BUY', transactionfor: 'corporate', journaltransactionid: 0 })
  assert.equal(row.is_buy, true)
  assert.equal(row.is_personal, false)
  assert.equal(row.journal_ref_id, null)
})

test('parseXml reads owners and their transactions, in any attribute order', () => {
  const xml = `<profile><esiowner name="Sir Cuddles" id="1903238489"><wallettransactions>
    <wallettransaction transactionid="1" transactiondatetime="1000" typeid="34" quantity="5" price="4.5" transactiontype="buy" transactionfor="personal" clientid="2" stationid="3"/>
    <wallettransaction typeid="35" transactionid="2" quantity="6" price="9" transactiondatetime="2000" transactiontype="sell" transactionfor="personal" clientid="2" stationid="3"/>
  </wallettransactions></esiowner><esiowner id="99" name="Empty"></esiowner></profile>`
  const parsed = parseXml(xml)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].characterId, 1903238489)
  assert.equal(parsed[0].name, 'Sir Cuddles')
  assert.deepEqual(
    parsed[0].transactions.map((t) => t.transactionid),
    ['1', '2']
  )
  assert.deepEqual(parsed[1].transactions, [])
})

test('decodeUtf16 follows the byte-order mark', () => {
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x41])
  const le = Buffer.from([0xff, 0xfe, 0x41, 0x00])
  assert.equal(decodeUtf16(be), 'A')
  assert.equal(decodeUtf16(le), 'A')
})

test('toRows imports only characters with exactly one registration, once per transaction', () => {
  const sources = [
    { characterId: 1, name: 'One', transactions: [sell, { ...sell }] },
    { characterId: 1, name: 'One', transactions: [{ ...sell, transactionid: '7' }] },
    { characterId: 2, name: 'Nobody', transactions: [{ ...sell, transactionid: '8' }] },
    { characterId: 3, name: 'Twice', transactions: [{ ...sell, transactionid: '9' }] },
  ]
  const registrations = [
    { id: 'reg-1', character_id: 1 },
    { id: 'reg-3a', character_id: '3' },
    { id: 'reg-3b', character_id: 3 },
  ]
  const { rows, skipped } = toRows(sources, registrations)
  assert.deepEqual(
    rows.map((r) => [r.transaction_id, r.registration_id]),
    [
      [6905589362, 'reg-1'],
      [7, 'reg-1'],
    ]
  )
  assert.deepEqual(skipped, [
    { characterId: 2, name: 'Nobody', reason: 'not registered here' },
    { characterId: 3, name: 'Twice', reason: '2 registrations' },
  ])
})

test('summarize counts rows and sells and finds the date range per registration', () => {
  const rows = [
    toRow('a', { ...sell, transactiondatetime: 2000 }),
    toRow('a', { ...sell, transactiondatetime: 1000, transactiontype: 'buy' }),
    toRow('b', { ...sell, transactiondatetime: 3000 }),
  ]
  assert.deepEqual(summarize(rows), [
    ['a', { count: 2, sells: 1, first: toIso(1000), last: toIso(2000) }],
    ['b', { count: 1, sells: 1, first: toIso(3000), last: toIso(3000) }],
  ])
})
