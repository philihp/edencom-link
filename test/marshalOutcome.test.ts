// Unit coverage for transferOutcome (src/app/api/fittings/marshalOutcome.ts):
// the reduction of a transfer's two step results into what the player is
// told and where they go. The branch that earns the test is the half-done
// transfer — saved on B, still on A — which no run against ESI can be made to
// produce on purpose.
import assert from 'node:assert/strict'
import test from 'node:test'

import { transferOutcome } from '../src/app/api/fittings/marshalOutcome.ts'

const from = { character_id: '1001', name: 'Philihp Hallgren' }
const to = { character_id: '2002', name: 'Alt Pilot' }
const archived = { fitting_id: 7, name: 'Cane', description: '', ship_type_id: 24702, items: [] }

test('both steps succeeded: go to the new fit on the target', () => {
  const out = transferOutcome(
    { restored: { fitting_id: 91, created: true }, archived: { archived, writeLogId: 5 } },
    from,
    to
  )
  assert.deepEqual(out, {
    ok: true,
    characterId: '2002',
    fittingId: 91,
    created: true,
    message: 'Moved to Alt Pilot.',
  })
})

test('target already held the fit: no slot spent, still a success', () => {
  const out = transferOutcome(
    { restored: { fitting_id: 12, created: false }, archived: { archived, writeLogId: 5 } },
    from,
    to
  )
  assert.equal(out.ok, true)
  assert.match(out.message, /already had this fit/)
})

test('restore refused: nothing moved, the refusal is the message', () => {
  const out = transferOutcome(
    { restored: { status: 507, error: 'Alt Pilot already has 500 of 500 fittings saved in EVE.' } },
    from,
    to
  )
  assert.deepEqual(out, {
    ok: false,
    stage: 'restore',
    status: 507,
    message: 'Alt Pilot already has 500 of 500 fittings saved in EVE.',
  })
})

test('a refusal before either step ran reads as a failed restore', () => {
  const out = transferOutcome({ status: 400, error: 'Transfer needs two different characters.' }, from, from)
  assert.equal(out.ok, false)
  assert.equal(out.ok === false && out.stage, 'restore')
})

test('saved on the target but the delete failed: on both, reported, pointing at the new fit', () => {
  const out = transferOutcome(
    { restored: { fitting_id: 91, created: true }, archived: { status: 502, error: 'EVE refused the delete: 420' } },
    from,
    to
  )
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.stage, 'archive')
  assert.equal(out.status, 502)
  assert.equal(out.savedCharacterId, '2002')
  assert.equal(out.savedFittingId, 91)
  assert.match(out.message, /Saved on Alt Pilot as fitting 91/)
  assert.match(out.message, /would not delete it from Philihp Hallgren/)
  assert.match(out.message, /both characters/)
})

test('a transfer that never reached the delete is the same half-done shape', () => {
  const out = transferOutcome({ restored: { fitting_id: 91, created: true } }, from, to)
  assert.equal(out.ok, false)
  if (out.ok) return
  assert.equal(out.stage, 'archive')
  assert.match(out.message, /never attempted/)
})

test('a nameless pilot is named by id', () => {
  const out = transferOutcome(
    { restored: { fitting_id: 1, created: true }, archived: { archived, writeLogId: 1 } },
    from,
    { character_id: '3003', name: null }
  )
  assert.equal(out.message, 'Moved to 3003.')
})
