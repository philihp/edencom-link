import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  coveringStructureShares,
  isPublicStructureShare,
  structureShareState,
  type StructureShareRow,
} from '../src/app/structure/shareRows.ts'

const row = (over: Partial<StructureShareRow> = {}): StructureShareRow => ({
  id: 'share-1',
  corporation_id: 98001,
  structure_id: 1030000000001,
  corporation_ids: [],
  alliance_ids: [],
  secret: null,
  tenants: false,
  seeded_default: false,
  ...over,
})

describe('isPublicStructureShare', () => {
  it('is the unseeded row naming nobody', () => {
    assert.equal(isPublicStructureShare(row()), true)
    assert.equal(isPublicStructureShare(row({ corporation_ids: null, alliance_ids: null })), true)
  })

  it('is not a row naming a corporation, an alliance or a link', () => {
    assert.equal(isPublicStructureShare(row({ corporation_ids: [98002] })), false)
    assert.equal(isPublicStructureShare(row({ alliance_ids: [99001] })), false)
    assert.equal(isPublicStructureShare(row({ secret: 'abc' })), false)
  })

  it('is not a tenants row — tenants are someone', () => {
    assert.equal(isPublicStructureShare(row({ tenants: true })), false)
  })

  it('is never the seeded alliance default, even with an empty alliance list', () => {
    assert.equal(isPublicStructureShare(row({ structure_id: null, seeded_default: true })), false)
    assert.equal(
      isPublicStructureShare(row({ structure_id: null, seeded_default: true, alliance_ids: [99001] })),
      false
    )
  })
})

describe('coveringStructureShares', () => {
  it('keeps the structure’s own row and the corporation-wide one, in order', () => {
    const own = row({ id: 'own' })
    const wide = row({ id: 'wide', structure_id: null })
    const other = row({ id: 'other', structure_id: 1030000000002 })
    assert.deepEqual(coveringStructureShares([wide, other, own], '1030000000001'), [wide, own])
  })

  it('matches a bigint handed back as a string', () => {
    const own = row({ structure_id: '1030000000001' })
    assert.deepEqual(coveringStructureShares([own], '1030000000001'), [own])
  })
})

describe('structureShareState', () => {
  it('carries the audiences, the tenants flag and the signed param', () => {
    const state = structureShareState(
      row({ corporation_ids: [98002], alliance_ids: [99001], secret: 's', tenants: true }),
      'signed'
    )
    assert.deepEqual(state, {
      corporationIds: [98002],
      allianceIds: [99001],
      hasLink: true,
      shareParam: 'signed',
      isPublic: false,
      tenants: true,
    })
  })

  it('drops a param when the row has no link to sign', () => {
    assert.equal(structureShareState(row(), 'stale').shareParam, null)
    assert.equal(structureShareState(row()).isPublic, true)
  })
})
