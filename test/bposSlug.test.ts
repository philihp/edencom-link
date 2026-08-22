import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { characterSlug, pickMain, slugLikePattern } from '../src/app/bpos/slug.ts'

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
