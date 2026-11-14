// The pure seams of recall_ship (src/app/api/mcp/memoryQuery.ts): which hull
// a name picks out, how far a share row reaches, and whether the memory came
// before the caller's time.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authorOf,
  describeReader,
  EXTRACT_INTERVAL_MS,
  inheritance,
  mailAuthor,
  MAX_AUTHOR_LENGTH,
  MAX_MEMORY_LENGTH,
  parseItemId,
  pickHeldOfType,
  pickHull,
  senderOwners,
  senderRefusal,
  subjectOf,
  validateMemory,
  writeFailure,
} from '../src/app/api/mcp/memoryQuery.ts'

test('an item id is a run of digits; anything else is a name', () => {
  assert.equal(parseItemId('1041234567890'), 1041234567890)
  assert.equal(parseItemId(' 1041234567890 '), 1041234567890)
  assert.equal(parseItemId('Rusty Kettle'), null)
  assert.equal(parseItemId('42'), null) // too short to be an item id; a ship named "42"
})

test('pickHull: the newest version per item, dead hulls marked, ambiguity refused', () => {
  const rows = [
    { item_id: 1, name: 'Rusty Kettle', type_id: 653, is_current: false, valid_until: '2026-01-01T00:00:00Z' },
    { item_id: 1, name: 'Rusty Kettle', type_id: 653, is_current: true, valid_until: '2026-02-01T00:00:00Z' },
    { item_id: 2, name: 'Rusty Kettle II', type_id: 653, is_current: false, valid_until: '2026-03-01T00:00:00Z' },
    { item_id: 3, name: null, type_id: 653, is_current: true, valid_until: '2026-03-01T00:00:00Z' },
  ]
  assert.deepEqual(pickHull('Rusty Kettle', rows), { ok: true, id: '1' })
  assert.deepEqual(pickHull('Kettle II', rows), { ok: true, id: '2' })
  const both = pickHull('Kettle', rows)
  assert.equal(both.ok, false)
  if (!both.ok) assert.match(both.message, /Rusty Kettle II \(no longer held\)/)
  assert.deepEqual(pickHull('2', rows), { ok: true, id: '2' })
})

test('describeReader: public when a row names no one and has no secret', () => {
  const row = { item_id: 1, corporation_ids: [], alliance_ids: [], secret: null }
  assert.equal(describeReader(row, 'ship').reach, 'everyone')
  assert.equal(describeReader(row, 'ship').by_link, false)
})

test('describeReader: audiences compose with a link, and show_as_main is carried', () => {
  const r = describeReader(
    { item_id: 1, corporation_ids: ['98000001'], alliance_ids: [], secret: 's3cret', show_as_main: true },
    'container'
  )
  assert.equal(r.reach, 'corporations_and_alliances')
  assert.deepEqual(r.corporation_ids, [98000001])
  assert.equal(r.by_link, true)
  assert.equal(r.hides_holder, true)
  assert.equal(r.subject, 'container')
  const linkOnly = describeReader({ item_id: 1, corporation_ids: [], alliance_ids: [], secret: 's' }, 'place')
  assert.equal(linkOnly.reach, 'link_holders')
})

test('subjectOf: the hull, a container above it, its place, or nothing', () => {
  assert.equal(subjectOf(10, 10, [20, 30], 60004588), 'ship')
  assert.equal(subjectOf('30', 10, [20, 30], 60004588), 'container')
  assert.equal(subjectOf(60004588, 10, [20, 30], 60004588), 'place')
  assert.equal(subjectOf(99, 10, [20, 30], 60004588), null)
  assert.equal(subjectOf(60004588, 10, [], null), null)
})

test('inheritance: a text by another account is inherited; one by the caller is theirs', () => {
  const mine = inheritance({ written_by: 'u1', valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1')
  assert.equal(mine.inherited, false)
  assert.equal(mine.written_by_you, true)
  const theirs = inheritance({ written_by: 'u2', valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1')
  assert.equal(theirs.inherited, true)
  // A version by a deleted account (written_by null) is still not the caller's.
  assert.equal(
    inheritance({ written_by: null, valid_from: '2026-02-01T00:00:00Z' }, [], '2026-01-01T00:00:00Z', 'u1').inherited,
    true
  )
  assert.equal(inheritance(null, [], '2026-01-01T00:00:00Z', 'u1').inherited, false)
})

test('inheritance: chapters before the caller’s record when the earliest visible write precedes their first sighting', () => {
  const versions = [
    { written_by: 'u2', valid_from: '2025-12-01T00:00:00Z' },
    { written_by: 'u1', valid_from: '2026-02-01T00:00:00Z' },
  ]
  const r = inheritance(versions[1], versions, '2026-01-01T00:00:00Z', 'u1')
  assert.equal(r.predates_your_record, true)
  assert.equal(r.memory_first_written, '2025-12-01T00:00:00Z')
  assert.equal(inheritance(versions[1], [versions[1]], '2026-01-01T00:00:00Z', 'u1').predates_your_record, false)
})

test('the extract intervals are the cron cadence: 6h for a character, a day for a corporation', () => {
  assert.equal(EXTRACT_INTERVAL_MS.character, 6 * 60 * 60 * 1000)
  assert.equal(EXTRACT_INTERVAL_MS.corporation, 24 * 60 * 60 * 1000)
})

test('validateMemory: blank refused, over the storage limit refused, otherwise the body as given', () => {
  assert.equal(validateMemory('   \n').ok, false)
  const long = validateMemory('x'.repeat(MAX_MEMORY_LENGTH + 1))
  assert.equal(long.ok, false)
  if (!long.ok) assert.match(long.message, /20,000/)
  assert.deepEqual(validateMemory('x'.repeat(MAX_MEMORY_LENGTH)), { ok: true, body: 'x'.repeat(MAX_MEMORY_LENGTH) })
  assert.deepEqual(validateMemory('# The Rusty Kettle\n\nAye.'), { ok: true, body: '# The Rusty Kettle\n\nAye.' })
})

test('authorOf: the client name, trimmed and capped, else mcp', () => {
  assert.equal(authorOf(undefined), 'mcp')
  assert.equal(authorOf('   '), 'mcp')
  assert.equal(authorOf(' Claude '), 'Claude')
  assert.equal(authorOf('a'.repeat(300)).length, 200)
})

test('writeFailure: the three SQLSTATEs the function raises read as what they mean', () => {
  assert.match(writeFailure({ code: '42501' }, 7), /do not hold item #7/)
  assert.match(writeFailure({ code: 'PT409' }, 7), /changed since you read it/)
  assert.match(writeFailure({ code: 'PT409' }, 7), /recall_item/)
  assert.match(writeFailure({ code: '23514' }, 7), /blank|20,000/)
  assert.equal(
    writeFailure({ code: 'XX000', message: 'boom', hint: 'try later' }, 7),
    'Writing the memory failed: boom (try later)'
  )
  assert.equal(writeFailure({}, 7), 'Writing the memory failed: unknown error')
})

test('pickHeldOfType: one held item of the type is the item; several are listed by id; none is a refusal', () => {
  const one = pickHeldOfType('Vexor Blueprint', [
    { item_id: 1011382969076, type_name: 'Vexor Blueprint', detail: 'original, ME 10 TE 20' },
  ])
  assert.deepEqual(one, { ok: true, id: '1011382969076' })

  const several = pickHeldOfType('Vexor Blueprint', [
    { item_id: 1, type_name: 'Vexor Blueprint', detail: 'original, ME 10 TE 20' },
    { item_id: 2, type_name: 'Vexor Blueprint', detail: 'original, ME 8 TE 16' },
  ])
  assert.equal(several.ok, false)
  if (!several.ok) {
    assert.match(several.message, /matches 2 items/)
    assert.match(several.message, /#1 Vexor Blueprint \(original, ME 10 TE 20\)/)
    assert.match(several.message, /#2 Vexor Blueprint \(original, ME 8 TE 16\)/)
  }

  const none = pickHeldOfType('Vexor Blueprint', [])
  assert.equal(none.ok, false)
  if (!none.ok) assert.match(none.message, /names no item of yours/)
})

test('pickHull takes the noun its refusal uses', () => {
  const picked = pickHull('Kettle', [], 'item')
  assert.equal(picked.ok, false)
  if (!picked.ok) assert.match(picked.message, /not one of your items/)
})

// ── speaking for a mail's sender ──────────────────────────────────────────

test('senderOwners: the character registrations, their corporations and accounts, never an alt', () => {
  const owners = senderOwners([
    { id: 'r1', user_id: 'u1', name: 'Sir Cuddles', corporation_id: 98000001 },
    { id: 'r2', user_id: 'u2', name: 'Sir Cuddles', corporation_id: '98000001' },
  ])
  assert.deepEqual(owners, {
    registrationIds: ['r1', 'r2'],
    corporationIds: ['98000001'],
    userIds: ['u1', 'u2'],
    name: 'Sir Cuddles',
  })
})

test('senderOwners: no corporation on record, and no name', () => {
  assert.deepEqual(senderOwners([{ id: 'r1', user_id: 'u1', name: null, corporation_id: null }]), {
    registrationIds: ['r1'],
    corporationIds: [],
    userIds: ['u1'],
    name: null,
  })
  assert.deepEqual(senderOwners([]).registrationIds, [])
})

test('mailAuthor: names the mail, after the client when one is given', () => {
  assert.equal(mailAuthor(undefined, 371234567), 'EVE mail 371234567')
  assert.equal(mailAuthor('  ', 371234567), 'EVE mail 371234567')
  assert.equal(mailAuthor('Aura', 371234567), 'Aura via EVE mail 371234567')
})

test('mailAuthor: a long client name is cut, the mail id never', () => {
  const author = mailAuthor('x'.repeat(500), 371234567)
  assert.equal(author.length, MAX_AUTHOR_LENGTH)
  assert.ok(author.endsWith(' via EVE mail 371234567'))
})

test('senderRefusal: each reason says what to do', () => {
  assert.match(senderRefusal({ reason: 'not_in_mail_copy', mailId: 5 }), /Mail 5 is not in the mail copy/)
  assert.match(
    senderRefusal({ reason: 'not_registered', mailId: 5, characterId: 90000001 }),
    /character 90000001\) is not registered on edencom\.link/
  )
  assert.match(
    senderRefusal({ reason: 'not_held', itemId: 9001, characterId: 90000001, name: 'Sir Cuddles' }),
    /^Sir Cuddles does not hold item #9001 now/
  )
  assert.match(
    senderRefusal({ reason: 'not_held', itemId: 9001, characterId: 90000001, name: null }),
    /^character 90000001 does not hold/
  )
})

test('writeFailure: a stale write names the recall tool to call again', () => {
  assert.match(writeFailure({ code: 'PT409' }, 9001), /Call recall_item again/)
  assert.match(writeFailure({ code: 'PT409' }, 9001, 'recall_item_for_sender'), /Call recall_item_for_sender again/)
})
