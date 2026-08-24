import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { characterSlug, pickCorporation, pickMain, slugLikePattern } from '../src/app/bpos/slug.ts'

describe('characterSlug', () => {
  it('lowercases and turns spaces into dashes', () => {
    assert.equal(characterSlug('Sir Cuddles'), 'sir-cuddles')
  })

  it('collapses runs of whitespace so one pilot has one slug', () => {
    assert.equal(characterSlug('  Sir   Cuddles '), 'sir-cuddles')
  })

  it('keeps the punctuation EVE names legitimately carry', () => {
    assert.equal(characterSlug("Ka'ren Vex-Tor"), "ka'ren-vex-tor")
  })
})

describe('slugLikePattern', () => {
  it('lets a dash stand for either a space or a literal dash', () => {
    assert.equal(slugLikePattern('sir-cuddles'), 'sir_cuddles')
  })

  it('escapes wildcards before substituting, so a typed % matches literally', () => {
    assert.equal(slugLikePattern('a%b_c-d'), 'a\\%b\\_c_d')
  })
})

describe('pickMain', () => {
  const oldest = { name: 'Oldest', is_main: false, created_at: '2020-01-01T00:00:00Z' }
  const newer = { name: 'Newer', is_main: false, created_at: '2024-01-01T00:00:00Z' }
  const flagged = { name: 'Flagged', is_main: true, created_at: '2025-01-01T00:00:00Z' }

  it('prefers the flagged main however late it was added', () => {
    assert.equal(pickMain([oldest, newer, flagged])?.name, 'Flagged')
  })

  it('falls back to the earliest character when none is flagged', () => {
    assert.equal(pickMain([newer, oldest])?.name, 'Oldest')
  })

  it('is null for an account with no characters', () => {
    assert.equal(pickMain([]), null)
  })
})

describe('pickCorporation', () => {
  const rows = [
    { corporation_id: 98001, name: 'Sudden Buggery' },
    { corporation_id: 98002, name: 'Dreddit' },
  ]

  it('finds the corporation whose name slugifies to the URL segment', () => {
    assert.deepEqual(pickCorporation(rows, 'sudden-buggery'), { corporationId: 98001, name: 'Sudden Buggery' })
  })

  it('rejects a row the wildcard probe over-matched', () => {
    // `_` matched the dash in the name, but the slug of "Sudden-Buggery" is
    // "sudden-buggery" — so an over-match only survives when it agrees exactly.
    assert.equal(pickCorporation([{ corporation_id: 98003, name: 'Suddenly Buggery' }], 'sudden-buggery'), null)
  })

  it('refuses an ambiguous slug rather than flipping a coin', () => {
    const ambiguous = [
      { corporation_id: 98001, name: 'Sudden Buggery' },
      { corporation_id: 98009, name: 'sudden buggery' },
    ]
    assert.equal(pickCorporation(ambiguous, 'sudden-buggery'), null)
  })

  it('is unbothered by the same corporation appearing twice', () => {
    const duplicated = [
      { corporation_id: 98001, name: 'Sudden Buggery' },
      { corporation_id: '98001', name: 'Sudden Buggery' },
    ]
    assert.deepEqual(pickCorporation(duplicated, 'sudden-buggery'), { corporationId: 98001, name: 'Sudden Buggery' })
  })

  it('ignores directory rows whose name has not been backfilled', () => {
    assert.equal(pickCorporation([{ corporation_id: 98004, name: null }], 'sudden-buggery'), null)
  })

  it('is null when nothing matches', () => {
    assert.equal(pickCorporation(rows, 'karmafleet'), null)
  })
})
