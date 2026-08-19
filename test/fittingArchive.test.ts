// The archive file format: what a fitting looks like on disk, and what gets
// let back into the game. The parse half is the one that matters — its input is
// a file on someone's laptop, so "the archive we wrote" is only one of the
// things it can be handed.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  contentHash,
  FITTING_SLOTS,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  normalizeItems,
  parseArchiveFitting,
  toArchiveFitting,
} from '../src/fittingArchive.ts'

const RIFTER = 587

const fit = (overrides = {}) => ({
  name: 'Doctrine Rifter',
  description: 'shield',
  ship_type_id: RIFTER,
  items: [
    { type_id: 2048, flag: 'LoSlot0', quantity: 1 },
    { type_id: 3520, flag: 'MedSlot0', quantity: 1 },
  ],
  ...overrides,
})

test('normalizeItems sorts by slot then type, and fills in a missing quantity', () => {
  const items = normalizeItems([
    { type_id: 3520, flag: 'MedSlot0' },
    { type_id: 2048, flag: 'LoSlot0', quantity: 1 },
  ])
  assert.deepEqual(items, [
    { type_id: 2048, flag: 'LoSlot0', quantity: 1 },
    { type_id: 3520, flag: 'MedSlot0', quantity: 1 },
  ])
})

test('normalizeItems tolerates a missing or non-array items field', () => {
  assert.deepEqual(normalizeItems(undefined), [])
  assert.deepEqual(normalizeItems('LoSlot0'), [])
})

test('contentHash ignores the order ESI serialized the modules in', () => {
  const a = contentHash(fit())
  const b = contentHash(fit({ items: [...fit().items].reverse() }))
  assert.equal(a, b)
})

test('contentHash separates fits that differ in any tracked field', () => {
  const base = contentHash(fit())
  assert.notEqual(base, contentHash(fit({ name: 'Doctrine Rifter ' })))
  assert.notEqual(base, contentHash(fit({ description: 'armor' })))
  assert.notEqual(base, contentHash(fit({ ship_type_id: 588 })))
  assert.notEqual(base, contentHash(fit({ items: [{ type_id: 2048, flag: 'LoSlot0', quantity: 2 }] })))
})

test('contentHash is blind to the fitting id, which the game reassigns on restore', () => {
  // The reason the archive keys on content: page a fit out and back in and EVE
  // gives it a new fitting_id, so the id can never be the identity of a file.
  const withId = { ...fit(), fitting_id: 12 }
  assert.equal(contentHash(withId), contentHash(fit()))
})

test('an archived file round-trips back into a restorable fitting', () => {
  const archived = toArchiveFitting({ ...fit(), fitting_id: 12 })
  assert.equal(archived.fitting_id, 12)

  const parsed = parseArchiveFitting(`${JSON.stringify(archived, null, 2)}\n`)
  assert.ok(parsed.ok)
  // fitting_id is dropped: the game mints a fresh one on POST.
  assert.deepEqual(parsed.fitting, fit())
  assert.equal(contentHash(parsed.fitting), contentHash(archived))
})

test('toArchiveFitting fills in the nulls a stored row may carry', () => {
  const archived = toArchiveFitting({
    fitting_id: '7',
    name: null,
    description: null,
    ship_type_id: '587',
    items: null,
  })
  assert.deepEqual(archived, { fitting_id: 7, name: '', description: '', ship_type_id: RIFTER, items: [] })
})

test('a file that is not a fitting is refused, not forwarded to ESI', () => {
  const refusals = ['', 'not json', '[]', 'null', '"a fitting"', '{}']
  refusals.forEach((text) => assert.equal(parseArchiveFitting(text).ok, false, text))
})

test('a fitting needs a name inside EVE limits', () => {
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ name: '   ' }))).ok, false)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ name: 'x'.repeat(MAX_NAME_LENGTH) }))).ok, true)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ name: 'x'.repeat(MAX_NAME_LENGTH + 1) }))).ok, false)
})

test('a fitting needs a description inside EVE limits, but may have none', () => {
  const none = parseArchiveFitting(JSON.stringify({ ...fit(), description: undefined }))
  assert.ok(none.ok)
  assert.equal(none.fitting.description, '')
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH) }))).ok, true)
  assert.equal(
    parseArchiveFitting(JSON.stringify(fit({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }))).ok,
    false
  )
})

test('a fitting needs a hull and a readable module list', () => {
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ ship_type_id: 0 }))).ok, false)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ ship_type_id: 'Rifter' }))).ok, false)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ items: undefined }))).ok, false)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ items: [{ type_id: 2048, quantity: 1 }] }))).ok, false)
  assert.equal(parseArchiveFitting(JSON.stringify(fit({ items: [{ flag: 'LoSlot0', quantity: 1 }] }))).ok, false)
  assert.equal(
    parseArchiveFitting(JSON.stringify(fit({ items: [{ type_id: 2048, flag: 'LoSlot0', quantity: 0 }] }))).ok,
    false
  )
})

test('an empty hull is a legitimate fitting', () => {
  // A named hull with nothing fitted is something players genuinely save, and
  // ESI accepts it — so the archive must not treat "no modules" as corruption.
  const parsed = parseArchiveFitting(JSON.stringify(fit({ items: [] })))
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.fitting.items, [])
})

test('unknown keys ride along harmlessly and are dropped', () => {
  const parsed = parseArchiveFitting(JSON.stringify({ ...fit(), fitting_id: 3, notes: 'from pyfa', _x: [1] }))
  assert.ok(parsed.ok)
  assert.deepEqual(Object.keys(parsed.fitting).sort(), ['description', 'items', 'name', 'ship_type_id'])
})

test('the in-game cap is the number the restore guard checks against', () => {
  assert.equal(FITTING_SLOTS, 500)
})
