// The Characters-tab fold: who ran industry jobs at each structure. The
// interesting cases are all identity — how much each extract actually tells us
// about who is behind a job, and so what a row is allowed to stand for. A
// personal job counts for the character who ran it; a corp job counts for the
// corporation it was run for, whoever installed it.
import assert from 'node:assert'
import test from 'node:test'

import { foldInstallers, type InstallerInput } from '../src/app/structure/installers.ts'

const STRUCT = '1054577764211'
const CORP = '98000001'

const input = (over: Partial<InstallerInput> = {}): InstallerInput => ({
  onPage: new Set([STRUCT]),
  since: '2026-08-01T00:00:00Z',
  registrations: new Map([
    ['reg-a', { name: 'Sir Cuddles', characterId: '90000001' }],
    ['reg-b', { name: 'Quuixote', characterId: null }],
  ]),
  corporationNames: new Map([[CORP, 'Sanguine Systems']]),
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

test('each of our characters keeps its own row', () => {
  // An account can hold the characters of several people sharing one tracker,
  // and nothing in the registration tells them apart — folding them under one
  // main hid eight people's work when this shipped that way.
  const roster = foldInstallers(
    [job({ job_id: 1, registration_id: 'reg-a' }), job({ job_id: 2, registration_id: 'reg-b' })],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'char:90000001', name: 'Sir Cuddles', kind: 'character', jobs: 1, eiv: 120_000_000, characters: 1 },
    { key: 'reg:reg-b', name: 'Quuixote', kind: 'character', jobs: 1, eiv: 80_000_000, characters: 1 },
  ])
})

test('a corp job counts for its corporation, not its installer', () => {
  const roster = foldInstallers([job({ job_id: 1, corporation_id: CORP, installer_id: '90000002' })], input())
  assert.deepEqual(roster.get(STRUCT), [
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 1, eiv: 120_000_000, characters: 1 },
  ])
})

test('a corp job installed by one of our own characters still counts for the corp', () => {
  // It was run as the corporation and the output landed in the corporation's
  // hangar — the installing character is incidental. Their own personal job at
  // the same structure stays their own row.
  const roster = foldInstallers(
    [job({ job_id: 1, registration_id: 'reg-a' }), job({ job_id: 2, corporation_id: CORP, installer_id: '90000001' })],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'char:90000001', name: 'Sir Cuddles', kind: 'character', jobs: 1, eiv: 120_000_000, characters: 1 },
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 1, eiv: 80_000_000, characters: 1 },
  ])
})

test('several corpmates in one corporation are one row that counts them', () => {
  const roster = foldInstallers(
    [
      job({ job_id: 1, corporation_id: CORP, installer_id: '90000002' }),
      job({ job_id: 2, corporation_id: CORP, installer_id: '90000003' }),
      job({ job_id: 3, corporation_id: CORP, installer_id: '90000002' }),
    ],
    input()
  )
  assert.deepEqual(roster.get(STRUCT), [
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 3, eiv: 240_000_000, characters: 2 },
  ])
})

test('one job listed by both extracts counts once, for the corp', () => {
  // "If it came in as a corp job, it groups by the corp" — so the corp
  // attribution wins the dedup whichever order the rows arrive in.
  const forwards = foldInstallers(
    [job({ job_id: 7, registration_id: 'reg-a' }), job({ job_id: 7, corporation_id: CORP, installer_id: '90000001' })],
    input()
  )
  const backwards = foldInstallers(
    [job({ job_id: 7, corporation_id: CORP, installer_id: '90000001' }), job({ job_id: 7, registration_id: 'reg-a' })],
    input()
  )
  const expected = [
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 1, eiv: 0, characters: 1 },
  ]
  assert.deepEqual(forwards.get(STRUCT), expected)
  assert.deepEqual(backwards.get(STRUCT), expected)
})

test('an unnamed corporation falls back to a labelled id', () => {
  const roster = foldInstallers([job({ job_id: 1, corporation_id: '98000099', installer_id: '90000002' })], input())
  assert.deepEqual(roster.get(STRUCT), [
    {
      key: 'corp:98000099',
      name: 'Corporation #98000099',
      kind: 'corporation',
      jobs: 1,
      eiv: 120_000_000,
      characters: 1,
    },
  ])
})

test('a corp row naming no corporation belongs to its installer', () => {
  // Nothing in the extract produces this today, but a job is never dropped for
  // want of a corporation id.
  const roster = foldInstallers([job({ job_id: 1, installer_id: '90000099' })], input())
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'char:90000099', name: 'Character #90000099', kind: 'character', jobs: 1, eiv: 120_000_000, characters: 1 },
  ])
})

test('window and page scope apply, ties sort by name', () => {
  const roster = foldInstallers(
    [
      job({ job_id: 1, registration_id: 'reg-a', start_date: '2026-07-30T00:00:00Z' }), // before window
      job({ job_id: 2, registration_id: 'reg-a', station_id: '999' }), // off page
      job({ job_id: 3, registration_id: 'reg-b' }),
      job({ job_id: 4, corporation_id: CORP, installer_id: '90000002' }),
    ],
    input()
  )
  // reg-b's job 3 priced at 40m; job 4 has no EIV entry (unpriceable) -> 0,
  // so the EIV-descending sort puts the account row first here.
  assert.deepEqual(roster.get(STRUCT), [
    { key: 'reg:reg-b', name: 'Quuixote', kind: 'character', jobs: 1, eiv: 40_000_000, characters: 1 },
    { key: `corp:${CORP}`, name: 'Sanguine Systems', kind: 'corporation', jobs: 1, eiv: 0, characters: 1 },
  ])
})
