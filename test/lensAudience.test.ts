// Unit coverage for turning a described audience into a lens's share columns.
//
// This is the seam where a model's words become who can see someone's data, so
// what's pinned here is the refusals as much as the matches: an audience the
// user isn't in, an ambiguous "my corp", and asking for public *and* a narrower
// audience in the same breath all have to fail rather than resolve to
// something plausible. The distinction between "not shared" and "shared with
// nobody" is pinned too — the second one means public in this table.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveAudience, type OwnAudiences } from '../src/app/lens/audience.ts'

const ONE_CORP: OwnAudiences = {
  corporations: [{ id: 98000001, name: 'KarmaFleet' }],
  alliances: [{ id: 99000001, name: 'Goonswarm Federation' }],
}

const TWO_CORPS: OwnAudiences = {
  corporations: [
    { id: 98000001, name: 'KarmaFleet' },
    { id: 98000002, name: 'Karmafleet University' },
  ],
  alliances: [],
}

const ok = (result: ReturnType<typeof resolveAudience>) => {
  assert.equal(result.ok, true, result.ok ? '' : result.message)
  return result.ok ? result.audience : (assert.fail('unreachable') as never)
}

const err = (result: ReturnType<typeof resolveAudience>) => {
  assert.equal(result.ok, false)
  return result.ok ? (assert.fail('unreachable') as never) : result.message
}

test('no audience at all is saved-but-not-shared, not public', () => {
  const audience = ok(resolveAudience({}, ONE_CORP))
  assert.equal(audience.shared, false)
  assert.equal(audience.isPublic, false)
  assert.deepEqual(audience.corporationIds, [])
})

test("public is shared with an empty audience — the table's spelling of everyone", () => {
  const audience = ok(resolveAudience({ isPublic: true }, ONE_CORP))
  assert.equal(audience.shared, true)
  assert.equal(audience.isPublic, true)
  assert.deepEqual(audience.corporationIds, [])
  assert.deepEqual(audience.allianceIds, [])
})

test('a corp plus a link is the "my corp or anyone with the URL" case', () => {
  const audience = ok(resolveAudience({ corporations: ['KarmaFleet'], link: true }, ONE_CORP))
  assert.deepEqual(audience.corporationIds, [98000001])
  assert.equal(audience.link, true)
  assert.equal(audience.isPublic, false)
  assert.equal(audience.shared, true)
})

test('names match case-insensitively, by substring, and by id', () => {
  assert.deepEqual(ok(resolveAudience({ corporations: ['karmafleet'] }, ONE_CORP)).corporationIds, [98000001])
  assert.deepEqual(ok(resolveAudience({ corporations: ['karma'] }, ONE_CORP)).corporationIds, [98000001])
  assert.deepEqual(ok(resolveAudience({ corporations: ['98000001'] }, ONE_CORP)).corporationIds, [98000001])
  assert.deepEqual(ok(resolveAudience({ alliances: ['goonswarm'] }, ONE_CORP)).allianceIds, [99000001])
})

test('"my corp" resolves only when there is exactly one to mean', () => {
  assert.deepEqual(ok(resolveAudience({ corporations: ['my corp'] }, ONE_CORP)).corporationIds, [98000001])
  assert.match(err(resolveAudience({ corporations: ['my corp'] }, TWO_CORPS)), /ambiguous/)
})

test('an exact name wins over a substring that would be ambiguous', () => {
  // "karmafleet" is a substring of both corp names, so substring matching alone
  // would call it ambiguous — the exact hit has to be preferred.
  assert.deepEqual(ok(resolveAudience({ corporations: ['KarmaFleet'] }, TWO_CORPS)).corporationIds, [98000001])
  // A substring that only one carries still resolves on its own.
  assert.deepEqual(ok(resolveAudience({ corporations: ['university'] }, TWO_CORPS)).corporationIds, [98000002])
})

test('a substring matching several corporations is refused, naming them', () => {
  assert.match(err(resolveAudience({ corporations: ['karmaflee'] }, TWO_CORPS)), /matches more than one/)
})

test('an audience the user is not in is refused, and the message says what they have', () => {
  const message = err(resolveAudience({ corporations: ['Pandemic Horde'] }, ONE_CORP))
  assert.match(message, /not one of your corporations/)
  assert.match(message, /KarmaFleet \(98000001\)/)
})

test("an id that is not the user's own is refused too", () => {
  assert.match(err(resolveAudience({ corporations: ['98000999'] }, ONE_CORP)), /not one of your corporations/)
})

test('public cannot be combined with a narrower audience', () => {
  assert.match(err(resolveAudience({ isPublic: true, corporations: ['KarmaFleet'] }, ONE_CORP)), /already visible/)
  assert.match(err(resolveAudience({ isPublic: true, link: true }, ONE_CORP)), /already visible/)
})

test('repeated requests for the same audience collapse to one id', () => {
  const audience = ok(resolveAudience({ corporations: ['KarmaFleet', 'karma', '98000001'] }, ONE_CORP))
  assert.deepEqual(audience.corporationIds, [98000001])
})
