// Unit coverage for the pure half of the one-time GEZ import
// (src/jobs/gezSheet.js): the sheet's layout, its service words, and the
// synthetic id band the corp-assets rig rewrite steers around.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isStubStructureId,
  parseCsv,
  parseRigList,
  rigSlotRows,
  STUB_STRUCTURE_ID_BASE,
  stubStructureId,
  toServices,
} from '../src/jobs/gezSheet.js'

const SHEET = [
  '"","System","Structure","Name","Service Modules","Rig Slot 1","Rig Slot 2","Rig Slot 3",""',
  '"","C-J6MT","Sotiyo","GEZ T2 Ship Comp Struct","Manufacturing, Capital","Standup XL-Set Ship Manufacturing Efficiency II ","",""',
  '"","","Tatara","GEZ T2 React Reproc","Composite, Reproc","Standup L-Set Reactor Efficiency II","Standup L-Set Reprocessing Monitor II",""',
  '"","I-NGI8 ","Raitaru","GEZ T2 Struct","Manufacturing","A","B","C"',
  '"","","Raitaru","GEZ T2 Struct","Manufacturing","A","B","C"',
  '"","","","","","","",""',
].join('\n')

test('parseCsv handles quoted commas, escaped quotes and CRLF', () => {
  assert.deepEqual(parseCsv('"a,b","say ""hi""",c\r\nd,,"e"\n'), [
    ['a,b', 'say "hi"', 'c'],
    ['d', '', 'e'],
  ])
})

test('parseRigList carries the system down and trims every cell', () => {
  const rows = parseRigList(SHEET)
  assert.deepEqual(rows[0], {
    system: 'C-J6MT',
    hull: 'Sotiyo',
    name: 'GEZ T2 Ship Comp Struct',
    services: ['Manufacturing', 'Capital'],
    rigs: ['Standup XL-Set Ship Manufacturing Efficiency II'],
  })
  assert.equal(rows[1].system, 'C-J6MT')
  assert.equal(rows[2].system, 'I-NGI8')
})

test('parseRigList drops a structure listed twice and blank rows', () => {
  assert.equal(parseRigList(SHEET).length, 3)
})

test('toServices maps sheet words to ESI service names and reports the rest', () => {
  assert.deepEqual(toServices(['Invent', 'Invention', 'Bio', 'Capital Research']), {
    services: [
      { name: 'Invention', state: 'online' },
      { name: 'Biochemical Reactions', state: 'online' },
    ],
    unknown: ['Capital Research'],
  })
})

test('stub ids are deterministic, in the band, and safe integers', () => {
  const id = stubStructureId(30000772, 35827, 'GEZ T2 Ship Comp Struct')
  assert.equal(id, stubStructureId(30000772, 35827, 'GEZ T2 Ship Comp Struct'))
  assert.notEqual(id, stubStructureId(30000772, 35836, 'GEZ T2 Ship Comp Struct'))
  assert.ok(isStubStructureId(id))
  assert.ok(id >= STUB_STRUCTURE_ID_BASE && Number.isSafeInteger(id))
  assert.ok(!isStubStructureId(1049854533347))
})

test('rigSlotRows numbers slots from RigSlot0', () => {
  assert.deepEqual(rigSlotRows(1, 2, [10, 20]), [
    { structure_id: 1, location_flag: 'RigSlot0', type_id: 10, corporation_id: 2 },
    { structure_id: 1, location_flag: 'RigSlot1', type_id: 20, corporation_id: 2 },
  ])
})
