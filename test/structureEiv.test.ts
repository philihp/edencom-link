// Pricing a job's Estimated Item Value and recovering the facility tax at a
// structure whose wallet we cannot read. The case that drove it: our jobs run
// in somebody else's Sotiyo, the tax leaves a character's personal wallet for a
// corp wallet RLS will never show, and the tile said nothing. The job's billed
// cost is EIV × (index × hull bonus + tax + SCC), and with CCP's adjusted
// prices mirrored every term but the tax is knowable — so the remainder is the
// owner's rate, the number ESI publishes nowhere.
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldEiv, hullCostMultiplier, indexAt, recoveredRate, SCC_SURCHARGE } from '../src/app/structure/eiv.ts'
import type { EivInput } from '../src/app/structure/eiv.ts'

const RENTED = '1000000000001'
const OURS = '1000000000002'

// One run of the bill costs 1000 ISK EIV: 10 × 60 + 20 × 20.
const bills = {
  999: [
    { typeID: 34, quantity: 10 },
    { typeID: 35, quantity: 20 },
  ],
}
const prices = new Map([
  [34, 60],
  [35, 20],
])

const baseInput = (over: Partial<EivInput> = {}): EivInput => ({
  onPage: new Set([RENTED, OURS]),
  since: '2026-08-01T00:00:00Z',
  bills,
  prices,
  indexSamples: new Map([
    [
      '30000142:manufacturing',
      [
        { recordedAt: '2026-08-01T00:00:00Z', costIndex: 0.03 },
        { recordedAt: '2026-08-20T00:00:00Z', costIndex: 0.05 },
      ],
    ],
  ]),
  systemOf: new Map([
    [RENTED, '30000142'],
    [OURS, '30000142'],
  ]),
  hullOf: new Map([
    [RENTED, 35827], // Sotiyo: 5% off the index term
    [OURS, 35825],
  ]),
  ownStructureIds: new Set([OURS]),
  journalPaidJobIds: new Set(),
  ...over,
})

const job = (over: object) => ({
  job_id: 1,
  activity_id: 1,
  blueprint_type_id: 999,
  runs: 1,
  cost: null,
  start_date: '2026-08-10T00:00:00Z',
  station_id: RENTED,
  facility_id: null,
  ...over,
})

test('EIV is the ME0 bill priced at adjusted prices, scaled by runs', () => {
  const result = foldEiv([job({ runs: 3 })], baseInput())
  assert.equal(result.byStructure.get(RENTED)?.eiv, 3000)
  assert.equal(result.totalEiv, 3000)
})

test('the recovered tax is the cost less the index fee and the SCC surcharge', () => {
  // EIV 1000 at index 0.03 in a Sotiyo: fee = 1000 × 0.03 × 0.95 = 28.5,
  // SCC = 40. A billed cost of 75 leaves 6.5 — a 0.65% owner, mid the usual
  // 0.25–1% band.
  const result = foldEiv([job({ cost: 75 })], baseInput())
  const row = result.byStructure.get(RENTED)!
  assert.ok(Math.abs(row.recoveredTax - 6.5) < 1e-9)
  assert.ok(Math.abs((recoveredRate(row) ?? 0) - 0.0065) < 1e-9)
})

test('the index is read as it stood when the job was installed', () => {
  // Installed the 25th: the 0.05 sample applies, not the 0.03 the window opened
  // with. fee = 1000 × 0.05 × 0.95 = 47.5, SCC 40 → tax 2.5.
  const result = foldEiv([job({ cost: 90, start_date: '2026-08-25T00:00:00Z' })], baseInput())
  assert.ok(Math.abs(result.byStructure.get(RENTED)!.recoveredTax - 2.5) < 1e-9)
})

test('recovery never runs at home, and never re-bills a journaled job', () => {
  // Our own structure: the journal is exact, an estimate would be worse — EIV
  // still counts.
  const home = foldEiv([job({ station_id: OURS, cost: 75 })], baseInput())
  assert.equal(home.byStructure.get(OURS)?.eiv, 1000)
  assert.equal(home.byStructure.get(OURS)?.recoveredTax, 0)
  // A corp-installed job at the rented structure whose outgoing entry the
  // journal already recorded: recovering it too would count one charge twice.
  const journaled = foldEiv([job({ cost: 75 })], baseInput({ journalPaidJobIds: new Set(['1']) }))
  assert.equal(journaled.byStructure.get(RENTED)?.recoveredTax, 0)
})

test('a job missing an input is counted skipped, never guessed at', () => {
  const noBill = foldEiv([job({ blueprint_type_id: 12345 })], baseInput())
  assert.equal(noBill.skipped.noBill, 1)
  const noPrice = foldEiv([job({})], baseInput({ prices: new Map([[34, 60]]) }))
  assert.equal(noPrice.skipped.noPrice, 1)
  assert.equal(noPrice.totalEiv, 0)
  const noIndex = foldEiv([job({ cost: 75 })], baseInput({ indexSamples: new Map() }))
  // EIV still counts — only the split needs the index.
  assert.equal(noIndex.byStructure.get(RENTED)?.eiv, 1000)
  assert.equal(noIndex.skipped.noIndex, 1)
  assert.equal(noIndex.byStructure.get(RENTED)?.recoveredTax, 0)
})

test('research and copy jobs contribute nothing — a different EIV base', () => {
  const result = foldEiv([job({ activity_id: 4 }), job({ job_id: 2, activity_id: 5 })], baseInput())
  assert.equal(result.totalEiv, 0)
})

test('reactions price like manufacturing, off their reaction bill', () => {
  const result = foldEiv(
    [job({ activity_id: 9 })],
    baseInput({
      indexSamples: new Map([['30000142:reaction', [{ recordedAt: '2026-08-01T00:00:00Z', costIndex: 0.02 }]]]),
    })
  )
  assert.equal(result.byStructure.get(RENTED)?.eiv, 1000)
})

test('one job priced once, both extract tables notwithstanding', () => {
  const result = foldEiv([job({}), job({})], baseInput())
  assert.equal(result.byStructure.get(RENTED)?.eiv, 1000)
})

test('a drifted price cannot recover a negative tax', () => {
  // cost below fee+SCC: stale inputs, not a rebate.
  const result = foldEiv([job({ cost: 10 })], baseInput())
  assert.equal(result.byStructure.get(RENTED)?.recoveredTax, 0)
})

test('the window filters on installation, when the ISK was charged', () => {
  const result = foldEiv([job({ start_date: '2026-07-30T00:00:00Z' })], baseInput())
  assert.equal(result.totalEiv, 0)
})

test('hull bonuses and the nearest-sample fallback', () => {
  assert.equal(hullCostMultiplier(35827), 0.95)
  assert.equal(hullCostMultiplier(35835), 1) // a refinery discounts nothing
  assert.equal(hullCostMultiplier(null), 1)
  const samples = [
    { recordedAt: '2026-08-10T00:00:00Z', costIndex: 0.03 },
    { recordedAt: '2026-08-20T00:00:00Z', costIndex: 0.05 },
  ]
  assert.equal(indexAt(samples, '2026-08-15T00:00:00Z'), 0.03)
  // Before tracking began: the earliest observation stands in.
  assert.equal(indexAt(samples, '2026-08-01T00:00:00Z'), 0.03)
  assert.equal(indexAt([], '2026-08-15T00:00:00Z'), null)
  assert.equal(SCC_SURCHARGE, 0.04)
})

test('a free landlord recovers a zero rate, not a missing one', () => {
  // Cost exactly index fee + SCC (the AGCP-I case): the owner charges nothing.
  // The fold must still count the job as recovered so the tile can SAY 0%,
  // and recoveredRate must report 0 rather than null.
  const input = baseInput()
  const idx = 0.03
  const eiv = 1000
  const result = foldEiv([job({ cost: eiv * (idx * 0.95 + SCC_SURCHARGE) })], input)
  const row = result.byStructure.get(RENTED)!
  assert.equal(row.recoveredJobs, 1)
  assert.equal(row.recoveredTax, 0)
  assert.equal(recoveredRate(row), 0)
})
