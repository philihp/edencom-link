// The write side of the structure-measure rollup: one owner's jobs and tax
// entries folded into per-(structure, owner, UTC day) rows. What matters is
// where each charge is FILED, because an account's figures are the sum over
// its owners and a charge filed twice is counted twice: a job's tax once,
// under the wallet that paid it; EIV under the registration whose character
// installed it; revenue under the wallet that received it.
import assert from 'node:assert/strict'
import test from 'node:test'

import { recoverFacilityTax } from '../src/app/structure/eiv.ts'
import {
  foldOwnerDays,
  indexProbeKey,
  jobLocationOf,
  utcDayOf,
  type OwnerFoldInput,
  type RollupEntry,
  type RollupJob,
} from '../src/app/structure/measureRollup.ts'

const OURS = 1000000000002
const RENTED = 1000000000001
const REG = '00000000-0000-0000-0000-0000000000aa'
const CHAR = '90000001'
const CORP = '98000001'
const LANDLORD = '98000009'

// One run of blueprint 999 costs 1000 ISK EIV: 10 × 60 + 20 × 20.
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

const job = (over: Partial<RollupJob> = {}): RollupJob => ({
  job_id: 1,
  activity_id: 1,
  blueprint_type_id: 999,
  runs: 1,
  cost: null,
  start_date: '2026-10-05T12:00:00+00:00',
  station_id: OURS,
  facility_id: OURS,
  ...over,
})

const entry = (over: Partial<RollupEntry> = {}): RollupEntry => ({
  corporation_id: CORP,
  amount: 100,
  date: '2026-10-05T12:00:01+00:00',
  context_id: 1,
  first_party_id: CHAR,
  second_party_id: CORP,
  ...over,
})

const registration = (over: Partial<OwnerFoldInput> = {}): OwnerFoldInput => ({
  owner: { kind: 'registration', id: REG, characterId: CHAR },
  personalJobs: [],
  corpJobs: [],
  entriesByJob: new Map(),
  walletEntries: [],
  jobLocations: new Map(),
  registeredInstallerIds: new Set(),
  hiddenJobIds: new Set(),
  pricing,
  indexes: new Map(),
  systemOf: new Map([
    [String(OURS), '30000142'],
    [String(RENTED), '30000142'],
  ]),
  hullOf: new Map([
    [String(OURS), 35825],
    [String(RENTED), 35827],
  ]),
  ...over,
})

const corporation = (over: Partial<OwnerFoldInput> = {}): OwnerFoldInput =>
  registration({ owner: { kind: 'corporation', id: CORP }, ...over })

const only = <T>(rows: T[]): T => {
  assert.equal(rows.length, 1, `expected one row, got ${JSON.stringify(rows)}`)
  return rows[0]
}

test('days are UTC calendar dates and a job is placed at its station, falling back to its facility', () => {
  assert.equal(utcDayOf('2026-10-05T23:59:59Z'), '2026-10-05')
  assert.equal(utcDayOf('2026-10-05T00:00:00+00:00'), '2026-10-05')
  assert.equal(jobLocationOf({ station_id: null, facility_id: RENTED }), RENTED)
  assert.equal(jobLocationOf({ station_id: 60003760, facility_id: RENTED }), 60003760)
  assert.equal(jobLocationOf({ station_id: null, facility_id: null }), 0)
})

test("a personal job's receipt is the registration's charge, and its EIV", () => {
  const { measures, installers } = foldOwnerDays(
    registration({
      personalJobs: [job({ registration_id: REG })],
      entriesByJob: new Map([['1', [entry()]]]),
    })
  )
  const m = only(measures)
  assert.equal(m.structure_id, OURS)
  assert.equal(m.registration_id, REG)
  assert.equal(m.corporation_id, null)
  assert.equal(m.utc_day, '2026-10-05')
  assert.equal(m.jobs, 1)
  assert.equal(m.tax_paid, 100)
  assert.equal(m.own_job_tax, 100)
  assert.equal(m.own_job_tax_jobs, 1)
  // The receipt sits in the landlord's wallet, which names the landlord.
  assert.deepEqual(m.tax_paid_by_landlord, { [CORP]: 100 })
  assert.equal(m.eiv, 1000)
  assert.equal(m.eiv_jobs, 1)
  // Revenue is a wallet's measure; a registration has none.
  assert.equal(m.revenue, 0)
  const i = only(installers)
  assert.equal(i.character_id, Number(CHAR))
  assert.equal(i.jobs, 1)
  assert.equal(i.eiv, 1000)
})

test('a job installed as the corporation is filed under the corporation, never the installer', () => {
  const corpJob = job({ corporation_id: CORP, installer_id: CHAR })
  const outgoing = entry({ amount: -100, first_party_id: CORP, second_party_id: LANDLORD, corporation_id: CORP })
  const entriesByJob = new Map([['1', [outgoing]]])

  // ESI's character listing carries the corp-installed job too: the
  // registration sees the outgoing entry and leaves the charge alone.
  const reg = foldOwnerDays(
    registration({ personalJobs: [job({ registration_id: REG })], corpJobs: [corpJob], entriesByJob })
  )
  const r = only(reg.measures)
  assert.equal(r.tax_paid, 0)
  assert.equal(r.own_job_tax, 0)
  // ...but the EIV is still the installer's, once.
  assert.equal(r.eiv, 1000)
  assert.equal(r.eiv_jobs, 1)
  // And the tab files it under the corporation: no character row.
  assert.deepEqual(reg.installers, [])

  const corp = foldOwnerDays(corporation({ corpJobs: [corpJob], entriesByJob }))
  const c = only(corp.measures)
  assert.equal(c.corporation_id, Number(CORP))
  assert.equal(c.tax_paid, 100)
  assert.equal(c.own_job_tax, 100)
  assert.deepEqual(c.tax_paid_by_landlord, { [LANDLORD]: 100 })
  // A corporation's row carries no EIV: the page cannot tell which of its
  // installers the reader holds.
  assert.equal(c.eiv, 0)
  const i = only(corp.installers)
  assert.equal(i.jobs, 1)
  assert.equal(i.eiv, 1000)
  assert.deepEqual(i.installer_ids, [Number(CHAR)])
})

test("an unregistered member's receipt is the corporation's avoidance basis but not tax it paid", () => {
  const stranger = '90000099'
  const { measures } = foldOwnerDays(
    corporation({
      corpJobs: [job({ corporation_id: CORP, installer_id: stranger })],
      entriesByJob: new Map([['1', [entry({ first_party_id: stranger })]]]),
      registeredInstallerIds: new Set([CHAR]),
    })
  )
  const m = only(measures)
  assert.equal(m.tax_paid, 0)
  assert.equal(m.own_job_tax, 100)
  assert.equal(m.own_job_tax_jobs, 1)
})

test("a registered member's receipt is left to their registration, so it is never filed twice", () => {
  const { measures } = foldOwnerDays(
    corporation({
      corpJobs: [job({ corporation_id: CORP, installer_id: CHAR })],
      entriesByJob: new Map([['1', [entry()]]]),
      registeredInstallerIds: new Set([CHAR]),
    })
  )
  const m = only(measures)
  assert.equal(m.tax_paid, 0)
  assert.equal(m.own_job_tax, 0)
})

test('the recovered tax runs only for an unbilled job with a cost and an index at install', () => {
  const rented = job({ registration_id: REG, station_id: RENTED, facility_id: RENTED, cost: 100 })
  const key = indexProbeKey('30000142', 'manufacturing', rented.start_date)
  const priced = foldOwnerDays(registration({ personalJobs: [rented], indexes: new Map([[key, 0.05]]) }))
  const m = only(priced.measures)
  assert.equal(m.recovered_jobs, 1)
  assert.equal(m.recovered_eiv, 1000)
  // 100 − 1000 × 0.05 × 0.95 (Sotiyo) − 1000 × 0.04 = 12.5
  assert.equal(m.recovered_tax, recoverFacilityTax({ eiv: 1000, cost: 100, costIndex: 0.05, hullTypeId: 35827 }))
  assert.equal(m.recovered_tax, 12.5)
  assert.equal(m.unpriced_jobs, 0)

  // No index sample: the EIV still counts, the recovery is skipped and said so.
  const unindexed = only(foldOwnerDays(registration({ personalJobs: [rented] })).measures)
  assert.equal(unindexed.eiv, 1000)
  assert.equal(unindexed.recovered_jobs, 0)
  assert.equal(unindexed.unpriced_jobs, 1)

  // Billed by the journal: the exact row is the record, nothing is estimated.
  const billed = only(
    foldOwnerDays(
      registration({
        personalJobs: [rented],
        indexes: new Map([[key, 0.05]]),
        entriesByJob: new Map([['1', [entry({ corporation_id: LANDLORD })]]]),
      })
    ).measures
  )
  assert.equal(billed.recovered_jobs, 0)
  assert.equal(billed.tax_paid, 100)
})

test('a job missing a bill or a price counts as unpriced, and research pushes nothing through', () => {
  const { measures } = foldOwnerDays(
    registration({
      personalJobs: [
        job({ job_id: 1, registration_id: REG, blueprint_type_id: 123 }),
        job({ job_id: 2, registration_id: REG, activity_id: 3 }),
      ],
    })
  )
  const m = only(measures)
  assert.equal(m.jobs, 2)
  assert.equal(m.eiv, 0)
  assert.equal(m.eiv_jobs, 0)
  assert.equal(m.unpriced_jobs, 1)
})

test("a corporation's wallet files what arrived as revenue at the job's structure, else at structure 0", () => {
  const { measures } = foldOwnerDays(
    corporation({
      walletEntries: [
        entry({ context_id: 77, first_party_id: '90000005' }),
        entry({ context_id: 78, first_party_id: '90000006', amount: 40 }),
        entry({ context_id: null, first_party_id: null, amount: 5 }),
      ],
      jobLocations: new Map([['77', RENTED]]),
    })
  )
  assert.equal(measures.length, 2)
  const placed = measures.find((m) => m.structure_id === RENTED)!
  assert.equal(placed.revenue, 100)
  assert.deepEqual(placed.revenue_by_payer, { '90000005': 100 })
  const unplaced = measures.find((m) => m.structure_id === 0)!
  assert.equal(unplaced.revenue, 45)
  assert.deepEqual(unplaced.revenue_by_payer, { '90000006': 40, unknown: 5 })
})

test('an outgoing charge for a job the extract never listed is tax paid at structure 0, by landlord', () => {
  const { measures } = foldOwnerDays(
    corporation({
      corpJobs: [job({ corporation_id: CORP })],
      walletEntries: [
        // This one names a held job: the job's own row has it already.
        entry({ amount: -100, context_id: 1, second_party_id: LANDLORD }),
        entry({ amount: -30, context_id: 999, second_party_id: LANDLORD }),
      ],
      entriesByJob: new Map([['1', [entry({ amount: -100, context_id: 1, second_party_id: LANDLORD })]]]),
    })
  )
  const held = measures.find((m) => m.structure_id === OURS)!
  assert.equal(held.tax_paid, 100)
  const unplaced = measures.find((m) => m.structure_id === 0)!
  assert.equal(unplaced.tax_paid, 30)
  assert.deepEqual(unplaced.tax_paid_by_landlord, { [LANDLORD]: 30 })
})

test('a hidden job keeps its share in the hidden columns of the tab row', () => {
  const { installers } = foldOwnerDays(
    corporation({
      corpJobs: [
        job({ job_id: 1, corporation_id: CORP, installer_id: CHAR }),
        job({ job_id: 2, corporation_id: CORP, installer_id: '90000002' }),
      ],
      hiddenJobIds: new Set(['2']),
    })
  )
  const i = only(installers)
  assert.equal(i.jobs, 1)
  assert.equal(i.eiv, 1000)
  assert.deepEqual(i.installer_ids, [Number(CHAR)])
  assert.equal(i.hidden_jobs, 1)
  assert.equal(i.hidden_eiv, 1000)
  assert.deepEqual(i.hidden_installer_ids, [90000002])
})

test('rows split by structure and by day', () => {
  const { measures } = foldOwnerDays(
    registration({
      personalJobs: [
        job({ job_id: 1, registration_id: REG }),
        job({ job_id: 2, registration_id: REG, start_date: '2026-10-06T00:00:00Z' }),
        job({ job_id: 3, registration_id: REG, station_id: RENTED, facility_id: RENTED }),
      ],
    })
  )
  assert.deepEqual(
    measures.map((m) => [m.structure_id, m.utc_day, m.jobs]).sort(),
    [
      [OURS, '2026-10-05', 1],
      [OURS, '2026-10-06', 1],
      [RENTED, '2026-10-05', 1],
    ].sort()
  )
})
