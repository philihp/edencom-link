// Unit coverage for the /fitting ship-matrix seam (src/app/fitting/shipMatrix.ts).
//
// What's worth pinning: column routing (empire race ids to their columns,
// meta-group Faction overriding an empire race id, unknown races falling into
// Faction rather than vanishing), class folding (T2 groups into their size
// class, unmapped groups surviving as their own trailing row), and row order
// (size order for known classes, never alphabetical).
import assert from 'node:assert/strict'
import test from 'node:test'

import type { SdeType } from '../src/sdeTypes.ts'
import {
  buildMatrix,
  classForGroupName,
  columnForType,
  RACE_COLUMNS,
  type MatrixEntry,
} from '../src/app/fitting/shipMatrix.ts'

const type = (
  typeID: number,
  name: string,
  groupName: string,
  raceID: number | null,
  metaGroupID: number | null
): SdeType => ({
  typeID,
  name,
  groupID: 0,
  categoryID: 6,
  groupName,
  raceID,
  metaGroupID,
})

const fit = (fittingId: number, shipTypeId: number, name: string, badge?: string): MatrixEntry => ({
  href: `/fitting/reg-1/${fittingId}`,
  name,
  shipTypeId,
  ...(badge ? { badge } : {}),
})

// Punisher (Amarr T1), Sacrilege (Amarr T2 HAC), Gila (Guristas — carries a
// Caldari race id but meta-group Faction), Venture (ORE, no empire race).
const TYPES: Record<number, SdeType> = {
  597: type(597, 'Punisher', 'Frigate', 4, 1),
  12019: type(12019, 'Sacrilege', 'Heavy Assault Cruiser', 4, 2),
  17715: type(17715, 'Gila', 'Cruiser', 1, 4),
  32880: type(32880, 'Venture', 'Mining Frigate', 128, null),
}

test('columnForType routes empires by race id and faction by meta group', () => {
  assert.equal(columnForType(TYPES[597]), 'Amarr')
  assert.equal(columnForType(TYPES[12019]), 'Amarr') // T2 stays with its empire
  assert.equal(columnForType(TYPES[17715]), 'Faction') // meta-group beats the Caldari race id
  assert.equal(columnForType(TYPES[32880]), 'Faction') // non-empire race
  assert.equal(columnForType(undefined), 'Faction') // unresolved type still renders somewhere
})

test('classForGroupName folds T2 groups into their size class and keeps unknowns', () => {
  assert.equal(classForGroupName('Heavy Assault Cruiser'), 'Cruiser')
  assert.equal(classForGroupName('Stealth Bomber'), 'Frigate')
  assert.equal(classForGroupName('Hauler'), 'Industrial')
  // A group this module has never heard of becomes its own row, not "Unknown".
  assert.equal(classForGroupName('Mining Frigate'), 'Mining Frigate')
  assert.equal(classForGroupName(null), 'Unknown')
})

test('buildMatrix orders rows by size class with unmapped groups trailing', () => {
  const rows = buildMatrix(
    [fit(1, 12019, 'HAM Sac'), fit(2, 597, 'Cheap Punisher'), fit(3, 32880, 'Gas Venture'), fit(4, 17715, 'Rat Gila')],
    TYPES
  )
  assert.deepEqual(
    rows.map((r) => r.shipClass),
    ['Frigate', 'Cruiser', 'Mining Frigate']
  )
  // Empty classes never render as rows.
  assert.ok(!rows.some((r) => r.shipClass === 'Battleship'))
})

test('buildMatrix places fits in the right cells and sorts by hull then name', () => {
  const rows = buildMatrix([fit(1, 12019, 'zz kiter'), fit(2, 12019, 'aa brawler'), fit(3, 17715, 'Rat Gila')], TYPES)
  const cruiser = rows.find((r) => r.shipClass === 'Cruiser')
  assert.ok(cruiser)
  assert.deepEqual(
    cruiser.cells.Amarr.map((f) => f.name),
    ['aa brawler', 'zz kiter']
  )
  assert.deepEqual(
    cruiser.cells.Faction.map((f) => f.hull),
    ['Gila']
  )
  // Every declared column exists on every row, even when empty.
  RACE_COLUMNS.forEach((col) => assert.ok(Array.isArray(cruiser.cells[col])))
  assert.equal(cruiser.cells.Minmatar.length, 0)
})

test('buildMatrix carries the source badge through to the cell', () => {
  const rows = buildMatrix([fit(1, 597, 'Doctrine Punisher', 'Corp'), fit(2, 597, 'My Punisher')], TYPES)
  const frigate = rows.find((r) => r.shipClass === 'Frigate')
  assert.ok(frigate)
  assert.deepEqual(
    frigate.cells.Amarr.map((f) => f.badge),
    ['Corp', undefined]
  )
})

test('buildMatrix survives a type the SDE lookup missed', () => {
  const rows = buildMatrix([fit(9, 99999999, 'mystery fit')], TYPES)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].shipClass, 'Unknown')
  assert.deepEqual(
    rows[0].cells.Faction.map((f) => f.hull),
    ['#99999999']
  )
})
