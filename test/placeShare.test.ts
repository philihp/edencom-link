import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { placeGrantors, placeShareHint, placeShareSubject } from '../src/app/asset/placeShare.ts'

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
  it('offers one share per own owner holding something here, characters first', () => {
    assert.deepEqual(placeGrantors(['667531913', 'reg-sarah', 'reg-sarah', 'reg-jenny'], owners), [
      { kind: 'character', registrationId: 'reg-jenny', name: 'Jenny Tayliah' },
      { kind: 'character', registrationId: 'reg-sarah', name: 'Sarah Okaski' },
      { kind: 'corporation', corporationId: 667531913, name: 'Hard Knocks Inc.' },
    ])
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

describe('placeShareHint', () => {
  it('names the owner and the place, and that nobody else’s items are included', () => {
    const hint = placeShareHint({ kind: 'character', registrationId: 'r', name: 'Sarah Okaski' }, 'Jita IV - Moon 4')
    assert.match(hint, /Sarah Okaski’s items at Jita IV - Moon 4/)
    assert.match(hint, /until you stop sharing/)
    assert.match(hint, /Nobody else’s items here are included/)
  })

  it('says any member can stop a corporation’s share', () => {
    const hint = placeShareHint({ kind: 'corporation', corporationId: 1, name: 'Hard Knocks Inc.' }, 'Somewhere')
    assert.match(hint, /until a member of Hard Knocks Inc\. stops sharing/)
  })
})

describe('placeShareSubject', () => {
  it('is the owner’s items here', () => {
    assert.equal(
      placeShareSubject({ kind: 'character', registrationId: 'r', name: 'Sarah Okaski' }),
      'Sarah Okaski’s items here'
    )
  })
})
