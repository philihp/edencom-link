// Unit coverage for the chunked IMPORTXML price endpoint. The one property a
// sheet depends on is alignment: row n of the result must be the price of the
// id in row n of the request, or every price below a gap is wrong.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  latestByType,
  MAX_TYPE_IDS,
  parseTypeIds,
  type PriceRow,
  priceDataXml,
} from '../src/app/sheets/market/priceData.ts'

const row = (type_id: number, over: Partial<PriceRow> = {}): PriceRow => ({
  type_id,
  buy_max: 3.78,
  sell_min: 3.98,
  strategy: 'orders',
  valid_from: '2026-09-01T00:00:00+00:00',
  valid_until: '2026-09-23T06:00:00+00:00',
  ...over,
})

const typeNodes = (xml: string) => [...xml.matchAll(/<type id="(\d+)">([\s\S]*?)<\/type>/g)]

test('parseTypeIds keeps request order and duplicates', () => {
  assert.deepEqual(parseTypeIds('35,34,35'), { ok: true, typeIds: [35, 34, 35] })
})

test('parseTypeIds skips the empty entries JOIN leaves for blank cells', () => {
  assert.deepEqual(parseTypeIds('34, 35,,,'), { ok: true, typeIds: [34, 35] })
})

test('parseTypeIds refuses a bad entry rather than dropping it', () => {
  assert.equal(parseTypeIds('34,Tritanium,35').ok, false)
  assert.equal(parseTypeIds('34,-1').ok, false)
  assert.equal(parseTypeIds('0').ok, false)
})

test('parseTypeIds refuses an empty or missing list', () => {
  assert.equal(parseTypeIds(null).ok, false)
  assert.equal(parseTypeIds(',,').ok, false)
})

test('parseTypeIds caps the chunk size', () => {
  const ids = Array.from({ length: MAX_TYPE_IDS }, (_, i) => i + 1)
  assert.equal(parseTypeIds(ids.join(',')).ok, true)
  assert.equal(parseTypeIds([...ids, MAX_TYPE_IDS + 1].join(',')).ok, false)
})

test('latestByType keeps the newer version at a version boundary', () => {
  const older = row(34, { buy_max: 3.5, valid_from: '2026-09-01T00:00:00+00:00' })
  const newer = row(34, { buy_max: 3.78, valid_from: '2026-09-10T00:00:00+00:00' })
  assert.equal(latestByType([newer, older]).get(34)?.buy_max, 3.78)
  assert.equal(latestByType([older, newer]).get(34)?.buy_max, 3.78)
})

test('priceDataXml answers one node per requested id, in request order', () => {
  const xml = priceDataXml('C-J6MT', [35, 99999999, 34, 35], [row(34), row(35, { buy_max: 16.77 })])
  assert.deepEqual(
    typeNodes(xml).map((m) => m[1]),
    ['35', '99999999', '34', '35']
  )
})

test('priceDataXml puts the columns in the CSV order', () => {
  const [[, , body]] = typeNodes(priceDataXml('jita', [34], [row(34)]))
  assert.deepEqual(
    [...body.matchAll(/<(\w+)>/g)].map((m) => m[1]),
    ['type_id', 'updated', 'buy', 'sell', 'since', 'strategy']
  )
  assert.match(body, /<type_id>34<\/type_id>/)
  assert.match(body, /<buy>3.78<\/buy>/)
  assert.match(body, /<updated>2026-09-23T06:00:00\+00:00<\/updated>/)
})

test('an empty side of the book is empty, never 0', () => {
  const [[, , body]] = typeNodes(priceDataXml('jita', [34], [row(34, { buy_max: null })]))
  assert.match(body, /<buy><\/buy>/)
  assert.match(body, /<sell>3.98<\/sell>/)
})

test('an unpriced type keeps its node with only type_id filled', () => {
  const [[, , body]] = typeNodes(priceDataXml('jita', [7], []))
  assert.match(body, /<type_id>7<\/type_id>/)
  assert.match(body, /<buy><\/buy>/)
  assert.match(body, /<strategy><\/strategy>/)
})

test('priceDataXml escapes text it did not write', () => {
  const xml = priceDataXml('a&b', [34], [row(34, { strategy: '<x>' })])
  assert.match(xml, /market="a&amp;b"/)
  assert.match(xml, /<strategy>&lt;x&gt;<\/strategy>/)
})
