// The read side of the structure-measure rollup: a window of day rows summed
// into what a tile shows. The rules worth pinning are the ones the rollup left
// to the reader — a receipt is a saving only where we own the structure, an
// estimate stands only where no journal of ours bills the charge, and a row
// with no tile still reaches the footers.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  foldInstallerWindow,
  foldMeasureWindow,
  type InstallerWindowRow,
  type MeasureWindowInput,
  type MeasureWindowRow,
} from '../src/app/structure/measureWindow.ts'

const OURS = '1000000000002'
const RENTED = '1000000000001'
const ELSEWHERE = '1000000000003'
const CORP = '98000001'
const LANDLORD = '98000009'
const REG = '00000000-0000-0000-0000-0000000000aa'

const row = (over: Partial<MeasureWindowRow> = {}): MeasureWindowRow => ({
  structure_id: OURS,
  registration_id: REG,
  corporation_id: null,
  utc_day: '2026-10-05',
  jobs: 1,
  revenue: 0,
  revenue_by_payer: {},
  tax_paid: 0,
  tax_paid_by_landlord: {},
  own_job_tax: 0,
  own_job_tax_jobs: 0,
  eiv: 0,
  eiv_jobs: 0,
  recovered_tax: 0,
  recovered_eiv: 0,
  recovered_jobs: 0,
  unpriced_jobs: 0,
  ...over,
})

const input = (over: Partial<MeasureWindowInput> = {}): MeasureWindowInput => ({
  onPage: new Set([OURS, RENTED]),
  structureOwner: new Map([
    [OURS, CORP],
    [RENTED, LANDLORD],
  ]),
  ownCorporationIds: new Set([CORP]),
  journalCoveredStructureIds: new Set([OURS]),
  listedOwners: new Set([CORP, LANDLORD]),
  ...over,
})

test('days sum per structure, and a receipt is a saving only where we own the structure', () => {
  const w = foldMeasureWindow(
    [
      row({ tax_paid: '100', own_job_tax: '100', own_job_tax_jobs: 1 }),
      row({ utc_day: '2026-10-06', tax_paid: '50', own_job_tax: '50', own_job_tax_jobs: 2 }),
      row({ structure_id: RENTED, tax_paid: 30, own_job_tax: 30, own_job_tax_jobs: 1 }),
    ],
    input()
  )
  assert.equal(w.taxesPaidByStructure.get(OURS), 150)
  assert.equal(w.taxesPaidByStructure.get(RENTED), 30)
  assert.deepEqual(w.ownReceipts, [
    { structureId: OURS, amount: 100 },
    { structureId: OURS, amount: 50 },
  ])
  assert.equal(w.ownReceiptJobs, 3)
})

test('the recovered estimate stands only where no journal of ours covers the structure', () => {
  const w = foldMeasureWindow(
    [
      row({ eiv: 1000, eiv_jobs: 1, recovered_tax: 10, recovered_eiv: 1000, recovered_jobs: 1 }),
      row({ structure_id: RENTED, eiv: 2000, eiv_jobs: 2, recovered_tax: 25, recovered_eiv: 2000, recovered_jobs: 2 }),
      row({ structure_id: RENTED, utc_day: '2026-10-06', unpriced_jobs: 1 }),
    ],
    input()
  )
  assert.deepEqual(w.eivByStructure.get(OURS), {
    eiv: 1000,
    jobs: 1,
    recoveredTax: 0,
    recoveredEiv: 0,
    recoveredJobs: 0,
  })
  assert.deepEqual(w.eivByStructure.get(RENTED), {
    eiv: 2000,
    jobs: 2,
    recoveredTax: 25,
    recoveredEiv: 2000,
    recoveredJobs: 2,
  })
  assert.equal(w.totalEiv, 3000)
  assert.equal(w.totalRecoveredTax, 25)
  assert.equal(w.unpricedJobs, 1)
})

test('revenue lands on the tile, and off the page it is unaccounted by payer', () => {
  const w = foldMeasureWindow(
    [
      row({ corporation_id: CORP, registration_id: null, revenue: 100, revenue_by_payer: { '90000001': 100 } }),
      row({
        corporation_id: CORP,
        registration_id: null,
        structure_id: ELSEWHERE,
        revenue: 40,
        revenue_by_payer: { '90000002': 40 },
      }),
      row({
        corporation_id: CORP,
        registration_id: null,
        structure_id: 0,
        revenue: 5,
        revenue_by_payer: { unknown: 5 },
      }),
    ],
    input()
  )
  assert.equal(w.revenueByStructure.get(OURS), 100)
  assert.equal(w.unaccounted, 45)
  assert.deepEqual(
    [...w.unaccountedByParty.entries()],
    [
      ['90000002', 40],
      ['unknown', 5],
    ]
  )
})

test('tax paid off the page is "elsewhere" by landlord, unless the landlord has a tile here', () => {
  const w = foldMeasureWindow(
    [
      row({ structure_id: ELSEWHERE, tax_paid: 30, tax_paid_by_landlord: { '98000777': 30 } }),
      row({ structure_id: 0, tax_paid: 20, tax_paid_by_landlord: { '98000777': 20 } }),
      // A landlord with a tile: the job simply didn't resolve. Dropped.
      row({ structure_id: 0, tax_paid: 99, tax_paid_by_landlord: { [LANDLORD]: 99 } }),
    ],
    input()
  )
  assert.equal(w.taxesPaidByStructure.size, 0)
  assert.deepEqual(
    [...w.unlistedLandlords.entries()],
    [['98000777', { amount: 50, structureIds: new Set([ELSEWHERE]) }]]
  )
})

test('a zero measure leaves the tile blank rather than showing 0', () => {
  const w = foldMeasureWindow([row()], input())
  assert.equal(w.revenueByStructure.has(OURS), false)
  assert.equal(w.taxesPaidByStructure.has(OURS), false)
  assert.equal(w.eivByStructure.has(OURS), false)
})

const installer = (over: Partial<InstallerWindowRow> = {}): InstallerWindowRow => ({
  structure_id: OURS,
  registration_id: REG,
  corporation_id: null,
  character_id: '90000001',
  jobs: 1,
  eiv: 100,
  installer_ids: null,
  hidden_jobs: 0,
  hidden_eiv: 0,
  hidden_installer_ids: null,
  ...over,
})

test('the Characters tab groups a registration by its character and a corporation by itself, busiest first', () => {
  const rows = foldInstallerWindow(
    [
      installer(),
      installer({ hidden_jobs: 1, hidden_eiv: 50 }),
      installer({ registration_id: 'reg-b', character_id: null, jobs: 3, eiv: 10 }),
      installer({
        registration_id: null,
        corporation_id: CORP,
        character_id: null,
        jobs: 2,
        eiv: 500,
        installer_ids: ['90000001', '90000002'],
      }),
      installer({
        registration_id: null,
        corporation_id: CORP,
        character_id: null,
        jobs: 1,
        eiv: 1,
        installer_ids: ['90000002'],
        hidden_installer_ids: ['90000003'],
      }),
    ],
    {
      registrations: new Map([[REG, { name: 'Sir Cuddles', characterId: '90000001' }]]),
      corporationNames: new Map([[CORP, 'Sanguine Systems']]),
    }
  )
  assert.deepEqual(rows.get(OURS), [
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 3, eiv: 501, characters: 3 },
    { key: 'char:90000001', name: 'Sir Cuddles', kind: 'character', jobs: 3, eiv: 250, characters: 1 },
    { key: 'reg:reg-b', name: 'Unknown character', kind: 'character', jobs: 3, eiv: 10, characters: 1 },
  ])
})
