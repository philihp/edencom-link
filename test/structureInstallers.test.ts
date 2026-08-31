// The Characters-tab fold: who ran industry jobs at each structure. The
// interesting cases are identity — the same person arriving through both
// extracts, and a registration with or without a known EVE id.
import assert from 'node:assert'
import test from 'node:test'

import { foldInstallers, type InstallerInput } from '../src/app/structure/installers.ts'

const STRUCT = '1054577764211'

const input = (over: Partial<InstallerInput> = {}): InstallerInput => ({
  onPage: new Set([STRUCT]),
  since: '2026-08-01T00:00:00Z',
  registrations: new Map([
    ['reg-a', { name: 'Sir Cuddles', characterId: '90000001' }],
    ['reg-b', { name: 'Quuixote', characterId: null }],
  ]),
  characterNames: new Map([['90000002', 'William Ralston']]),
  eivByJob: new Map([
    ['1', 120_000_000],
    ['2', 80_000_000],
    ['3', 40_000_000],
  ]),
  ...over,
})

const job = (over: object) => ({
  job_id: 1,
  station_id: STRUCT,
  facility_id: null,
  start_date: '2026-08-10T00:00:00Z',
  ...over,
})

test('personal and corp jobs land under their installer, busiest first', () => {
  const roster = foldInstallers(
    [
      job({ job_id: 1, registration_id: 'reg-a' }),
      job({ job_id: 2, registration_id: 'reg-a' }),
      job({ job_id: 3, installer_id: '90000002' }),
    ],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'char:90000001', name: 'Sir Cuddles', jobs: 2, eiv: 200_000_000 },
    { key: 'char:90000002', name: 'William Ralston', jobs: 1, eiv: 40_000_000 },
  ])
})

test('the same person through both extracts is one row', () => {
  // Their personal job names the registration; a corp job they installed
  // names their EVE id. The registration knows that id, so the two collapse.
  const roster = foldInstallers(
    [job({ job_id: 1, registration_id: 'reg-a' }), job({ job_id: 2, installer_id: '90000001' })],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [{ key: 'char:90000001', name: 'Sir Cuddles', jobs: 2, eiv: 200_000_000 }])
})

test('one job listed by both extracts counts once', () => {
  const roster = foldInstallers(
    [job({ job_id: 7, registration_id: 'reg-a' }), job({ job_id: 7, installer_id: '90000001' })],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [{ key: 'char:90000001', name: 'Sir Cuddles', jobs: 1, eiv: 0 }])
})

test('a registration without an EVE id still gets a row', () => {
  const roster = foldInstallers([job({ job_id: 1, registration_id: 'reg-b' })], input())
  assert.deepEqual(roster.get(STRUCT), [{ key: 'reg:reg-b', name: 'Quuixote', jobs: 1, eiv: 120_000_000 }])
})

test('an unresolved corp installer falls back to a labelled id', () => {
  const roster = foldInstallers([job({ job_id: 1, installer_id: '90000099' })], input())
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'char:90000099', name: 'Character #90000099', jobs: 1, eiv: 120_000_000 },
  ])
})

test('window and page scope apply, ties sort by name', () => {
  const roster = foldInstallers(
    [
      job({ job_id: 1, registration_id: 'reg-a', start_date: '2026-07-30T00:00:00Z' }), // before window
      job({ job_id: 2, registration_id: 'reg-a', station_id: '999' }), // off page
      job({ job_id: 3, registration_id: 'reg-b' }),
      job({ job_id: 4, installer_id: '90000002' }),
    ],
    input()
  )
  // reg-b's job 3 priced at 40m; job 4 has no EIV entry (unpriceable) -> 0,
  // so the EIV-descending sort also puts Quuixote first here.
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'reg:reg-b', name: 'Quuixote', jobs: 1, eiv: 40_000_000 },
    { key: 'char:90000002', name: 'William Ralston', jobs: 1, eiv: 0 },
  ])
})
