// The hand-inferred structure fittings (src/jobs/inferredStructures.js): the
// table is data somebody typed, so the checks the importer runs before it
// writes anything run here too, against the committed table.
import assert from 'node:assert/strict'
import test from 'node:test'

import { isStubStructureId } from '../src/jobs/gezSheet.js'
import {
  INFERRED_STRUCTURES,
  STUB_REKEYS,
  inferredProblems,
  owners,
  toServiceRows,
} from '../src/jobs/inferredStructures.js'

test('the committed table has no problems', () => {
  assert.deepEqual(inferredProblems(INFERRED_STRUCTURES), [])
})

test('inferredProblems names a wrong-size rig, an unknown service and an overfull fit', () => {
  const problems = inferredProblems([
    {
      structureId: 1,
      name: 'X - Test',
      hull: 'Raitaru',
      owner: { corporationId: 1, name: 'c', allianceId: null },
      services: ['Manufacturing', 'Manufacturing (Standard)'],
      rigs: ['Standup L-Set Reactor Efficiency I', 'a', 'b', 'c'],
      evidence: '',
    },
  ])
  assert.ok(problems.some((p) => p.includes('4 rigs')))
  assert.ok(problems.some((p) => p.includes('"Manufacturing" is not an ESI service name')))
  assert.ok(problems.some((p) => p.includes('Reactor Efficiency I" is not a M-Set rig')))
  assert.equal(inferredProblems([]).length, 0)
})

test('every structure id is a real Upwell id, named once', () => {
  const ids = [...INFERRED_STRUCTURES.map((s) => s.structureId), ...STUB_REKEYS.map((r) => r.structureId)]
  assert.equal(new Set(ids).size, ids.length)
  ids.forEach((id) => assert.ok(id >= 100_000_000_000 && !isStubStructureId(id), `${id}`))
  STUB_REKEYS.forEach((r) => assert.ok(isStubStructureId(r.stubId), `${r.stubId} is not a stub id`))
})

test('owners are listed once each and belong to an alliance', () => {
  const list = owners()
  assert.equal(new Set(list.map((o) => o.corporationId)).size, list.length)
  list.forEach((o) => assert.equal(o.allianceId, 1354830081, o.name))
})

test('toServiceRows is the ESI shape', () => {
  assert.deepEqual(toServiceRows(['Invention']), [{ name: 'Invention', state: 'online' }])
})
