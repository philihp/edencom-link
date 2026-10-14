import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { grantorKey, placeGrantors, placeShareSubject } from '../src/app/asset/placeShare.ts'

const owners = {
  characters: [
    { id: 'reg-jenny', name: 'Jenny Tayliah' },
    { id: 'reg-sarah', name: 'Sarah Okaski' },
  ],
  corporations: [
    { id: '667531913', name: 'Hard Knocks Inc.' },
    { id: '98832954', name: 'Idle Corp' },
  ],
}

describe('placeGrantors', () => {
  it('offers one character share however many characters hold something, then each corporation', () => {
    assert.deepEqual(placeGrantors(['667531913', 'reg-sarah', 'reg-sarah', 'reg-jenny'], owners), [
      { kind: 'character' },
      { kind: 'corporation', corporationId: 667531913, name: 'Hard Knocks Inc.' },
    ])
  })

  it('offers only the corporation share when no character holds anything', () => {
    assert.deepEqual(placeGrantors(['98832954'], owners), [
      { kind: 'corporation', corporationId: 98832954, name: 'Idle Corp' },
    ])
  })

  it('offers only the character share when no corporation holds anything', () => {
    assert.deepEqual(placeGrantors(['reg-jenny'], owners), [{ kind: 'character' }])
  })

  it('never offers a share for an owner who is not the caller’s', () => {
    // A root another account shared with the caller lists under its holder,
    // who is not among the caller's owners.
    assert.deepEqual(placeGrantors(['reg-someone-else', '12345'], owners), [])
  })

  it('offers nothing at a place where the caller holds nothing', () => {
    assert.deepEqual(placeGrantors([], owners), [])
  })
})

describe('grantorKey', () => {
  it('tells the options apart', () => {
    assert.equal(grantorKey({ kind: 'character' }), 'characters')
    assert.equal(grantorKey({ kind: 'corporation', corporationId: 7, name: 'x' }), 'corp-7')
  })
})

describe('placeShareSubject', () => {
  it('names the kind of share', () => {
    assert.equal(placeShareSubject({ kind: 'character' }), 'Your characters’ items here')
    assert.equal(
      placeShareSubject({ kind: 'corporation', corporationId: 1, name: 'Hard Knocks Inc.' }),
      'Hard Knocks Inc.’s items here'
    )
  })
})
