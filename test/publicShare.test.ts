import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isPublicShare, pickPublicShare } from '../src/app/asset/publicShare.ts'

type Row = {
  id: string
  item_id: number
  registration_id: string
  corporation_ids: number[] | null
  alliance_ids: number[] | null
  secret: string | null
}

const row = (over: Partial<Row>): Row => ({
  id: 'a',
  item_id: 1,
  registration_id: 'reg-a',
  corporation_ids: [],
  alliance_ids: [],
  secret: null,
  ...over,
})

const grantor = (r: Row) => r.registration_id

describe('isPublicShare', () => {
  it('is the row naming nobody', () => {
    assert.equal(isPublicShare(row({})), true)
    assert.equal(isPublicShare(row({ corporation_ids: null, alliance_ids: null })), true)
  })

  it('is not a row with a link secret or an audience', () => {
    assert.equal(isPublicShare(row({ secret: 'abc' })), false)
    assert.equal(isPublicShare(row({ corporation_ids: [98000001] })), false)
    assert.equal(isPublicShare(row({ alliance_ids: [99000001] })), false)
  })
})

describe('pickPublicShare', () => {
  it('answers null when no covering row is public', () => {
    assert.equal(pickPublicShare([row({ secret: 's' }), row({ id: 'b', alliance_ids: [1] })], [1], grantor), null)
    assert.equal(pickPublicShare([], [1], grantor), null)
  })

  it('opens the item on its own public row', () => {
    const own = row({})
    assert.equal(pickPublicShare([own], [1, 10, 60003760], grantor), own)
  })

  it('opens the item on a public row covering a container above it', () => {
    const container = row({ id: 'c', item_id: 10 })
    assert.equal(pickPublicShare([container], [1, 10, 60003760], grantor), container)
  })

  it('prefers the nearest subject when several of one grantor cover the item', () => {
    const place = row({ id: 'p', item_id: 60003760 })
    const container = row({ id: 'c', item_id: 10 })
    assert.equal(pickPublicShare([place, container], [1, 10, 60003760], grantor), container)
  })

  it('ignores a private row nearer than the public one', () => {
    const own = row({ secret: 's' })
    const container = row({ id: 'c', item_id: 10 })
    assert.equal(pickPublicShare([own, container], [1, 10, 60003760], grantor), container)
  })

  it('refuses when public rows come from more than one grantor', () => {
    const mine = row({ id: 'p', item_id: 60003760 })
    const theirs = row({ id: 'q', item_id: 60003760, registration_id: 'reg-b' })
    assert.equal(pickPublicShare([mine, theirs], [60003760], grantor), null)
  })

  it('does not count a private row of another grantor as ambiguity', () => {
    const mine = row({ id: 'p', item_id: 60003760 })
    const theirs = row({ id: 'q', item_id: 60003760, registration_id: 'reg-b', secret: 's' })
    assert.equal(pickPublicShare([mine, theirs], [60003760], grantor), mine)
  })
})
