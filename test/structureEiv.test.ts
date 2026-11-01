// Pricing a job's Estimated Item Value and recovering the facility tax at a
// structure whose wallet we cannot read. The case that drove it: our jobs run
// in somebody else's Sotiyo, the tax leaves a character's personal wallet for a
// corp wallet RLS will never show, and the tile said nothing. The job's billed
// cost is EIV × (index × hull bonus + tax + SCC), and with CCP's adjusted
// prices mirrored every term but the tax is knowable — so the remainder is the
// owner's rate, the number ESI publishes nowhere.
//
// These are the per-job primitives; the fold over an owner's jobs is covered
// by structureMeasureRollup.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hullCostMultiplier,
  isPriceable,
  priceJobEiv,
  recoverFacilityTax,
  recoveredRate,
  SCC_SURCHARGE,
} from '../src/app/structure/eiv.ts'

// One run of the bill costs 1000 ISK EIV: 10 × 60 + 20 × 20.
const pricing = {
  bills: {
    999: [
      { typeID: 34, quantity: 10 },
      { typeID: 35, quantity: 20 },
    ],
  },
  prices: new Map([
    [34, 60],
    [35, 20],
  ]),
}

test('EIV is the ME0 bill at adjusted prices, scaled by runs', () => {
  assert.deepEqual(priceJobEiv({ activity_id: 1, blueprint_type_id: 999, runs: 3 }, pricing), { eiv: 3000 })
  assert.deepEqual(priceJobEiv({ activity_id: 9, blueprint_type_id: 999, runs: 1 }, pricing), { eiv: 1000 })
})

test('only manufacturing and reactions are priced; research pushes no materials through', () => {
  assert.equal(isPriceable({ activity_id: 3 }), false)
  assert.equal(priceJobEiv({ activity_id: 3, blueprint_type_id: 999, runs: 1 }, pricing), null)
  assert.equal(priceJobEiv({ activity_id: 1, blueprint_type_id: 999, runs: 0 }, pricing), null)
})

test('a missing bill or an unpriced material refuses the job rather than under-pricing it', () => {
  assert.deepEqual(priceJobEiv({ activity_id: 1, blueprint_type_id: 123, runs: 1 }, pricing), { missing: 'noBill' })
  assert.deepEqual(
    priceJobEiv({ activity_id: 1, blueprint_type_id: 999, runs: 1 }, { ...pricing, prices: new Map([[34, 60]]) }),
    {
      missing: 'noPrice',
    }
  )
})

test('the recovered tax is the cost less the index fee (hull bonus applied) and the SCC surcharge, never negative', () => {
  // 100 − 1000 × 0.05 × 0.95 − 1000 × 0.04 = 12.5
  assert.equal(recoverFacilityTax({ eiv: 1000, cost: 100, costIndex: 0.05, hullTypeId: 35827 }), 12.5)
  // No hull bonus for a citadel: 100 − 50 − 40 = 10
  assert.equal(recoverFacilityTax({ eiv: 1000, cost: 100, costIndex: 0.05, hullTypeId: 35832 }), 10)
  assert.equal(recoverFacilityTax({ eiv: 1000, cost: 1, costIndex: 0.05, hullTypeId: null }), 0)
  assert.equal(SCC_SURCHARGE, 0.04)
  assert.equal(hullCostMultiplier(35825), 0.97)
  assert.equal(hullCostMultiplier(null), 1)
})

test('the recovered rate is tax over EIV, and zero is an answer where the landlord is free', () => {
  assert.equal(recoveredRate({ eiv: 1000, jobs: 1, recoveredTax: 12.5, recoveredEiv: 1000, recoveredJobs: 1 }), 0.0125)
  assert.equal(recoveredRate({ eiv: 1000, jobs: 1, recoveredTax: 0, recoveredEiv: 1000, recoveredJobs: 1 }), 0)
  assert.equal(recoveredRate({ eiv: 1000, jobs: 1, recoveredTax: 0, recoveredEiv: 0, recoveredJobs: 0 }), null)
})
