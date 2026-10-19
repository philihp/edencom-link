// Unit coverage for the module_variants seam (src/app/api/mcp/variantQuery.ts).
//
// What is worth pinning: which rows count as upgrades (meta level above the
// type asked about, whichever member that is), that unpublished variants stay
// out unless asked for while the asked-about type never disappears, and that a
// plain Tech I type — which the SDE stamps with no meta group — reads as Tech I.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ABYSSAL_META_GROUP_ID,
  formatFamily,
  parseTypeRef,
  tierName,
  type VariantLike,
} from '../src/app/api/mcp/variantQuery.ts'

const variant = (over: Partial<VariantLike> & Pick<VariantLike, 'typeID' | 'name'>): VariantLike => ({
  metaGroupID: null,
  metaGroupName: null,
  metaLevel: 0,
  published: true,
  isParent: false,
  ...over,
})

// The Damage Control family, in the RPC's order (lowest meta level first).
const FAMILY: VariantLike[] = [
  variant({ typeID: 2046, name: 'Damage Control I', isParent: true }),
  variant({ typeID: 5839, name: 'IFFA Compact Damage Control', metaGroupID: 1, metaGroupName: 'Tech I', metaLevel: 1 }),
  variant({ typeID: 99902, name: 'Prototype Damage Control', metaGroupID: 1, metaLevel: 3, published: false }),
  variant({ typeID: 2048, name: 'Damage Control II', metaGroupID: 2, metaGroupName: 'Tech II', metaLevel: 5 }),
  variant({
    typeID: 99901,
    name: 'Republic Fleet Damage Control',
    metaGroupID: 4,
    metaGroupName: 'Faction',
    metaLevel: 8,
  }),
]

const BLUEPRINTS: Record<number, string> = {
  2046: 'Damage Control I Blueprint',
  2048: 'Damage Control II Blueprint',
}
const blueprintOf = (id: number) => BLUEPRINTS[id]

test('a bare positive integer is a type id, anything else a name', () => {
  assert.deepEqual(parseTypeRef(' 2048 '), { kind: 'id', typeID: 2048 })
  assert.deepEqual(parseTypeRef('Damage Control II'), { kind: 'name', query: 'Damage Control II' })
  assert.deepEqual(parseTypeRef('0'), { kind: 'name', query: '0' })
  assert.deepEqual(parseTypeRef('Fullerite-C50'), { kind: 'name', query: 'Fullerite-C50' })
})

test('a type with no meta group is Tech I; an unnamed group still names its id', () => {
  assert.equal(tierName({ metaGroupID: null, metaGroupName: null }), 'Tech I')
  assert.equal(tierName({ metaGroupID: 4, metaGroupName: 'Faction' }), 'Faction')
  assert.equal(tierName({ metaGroupID: 99, metaGroupName: null }), 'Meta group 99')
})

test('variants above the asked-about meta level are the upgrades', () => {
  const fromT2 = formatFamily(FAMILY, 2048, false, blueprintOf)
  assert.deepEqual(
    fromT2.rows.filter((r) => r.higher_meta).map((r) => r.name),
    ['Republic Fleet Damage Control']
  )
  assert.equal(fromT2.higherMeta, 1)
  assert.equal(fromT2.rows.find((r) => r.this)?.name, 'Damage Control II')

  // Asked from the root, everything published above meta 0 is an upgrade.
  const fromT1 = formatFamily(FAMILY, 2046, false, blueprintOf)
  assert.equal(fromT1.higherMeta, 3)
  assert.equal(fromT1.root, 'Damage Control I')
})

test('unpublished variants stay out unless asked for, and are counted', () => {
  const hidden = formatFamily(FAMILY, 2048, false, blueprintOf)
  assert.equal(
    hidden.rows.some((r) => r.name === 'Prototype Damage Control'),
    false
  )
  assert.equal(hidden.hiddenUnpublished, 1)

  const shown = formatFamily(FAMILY, 2048, true, blueprintOf)
  const prototype = shown.rows.find((r) => r.name === 'Prototype Damage Control')
  assert.equal(prototype?.published, false)
  assert.equal(shown.hiddenUnpublished, 0)
})

test('the asked-about type is listed even when unpublished', () => {
  const result = formatFamily(FAMILY, 99902, false, blueprintOf)
  assert.ok(result.rows.some((r) => r.this && r.name === 'Prototype Damage Control'))
  assert.deepEqual(
    result.rows.filter((r) => r.higher_meta).map((r) => r.type_id),
    ['2048', '99901']
  )
})

test('rows carry the blueprint that builds them, ids as strings, the tier name', () => {
  const { rows } = formatFamily(FAMILY, 2048, false, blueprintOf)
  assert.deepEqual(rows[0], {
    type_id: '2046',
    name: 'Damage Control I',
    meta_level: 0,
    tier: 'Tech I',
    blueprint: 'Damage Control I Blueprint',
  })
  assert.equal(rows.find((r) => r.type_id === '99901')?.blueprint, undefined)
})

test('an Abyssal member is flagged so the caller can warn about rolled attributes', () => {
  const withAbyssal = [
    ...FAMILY,
    variant({ typeID: 52230, name: 'Abyssal Damage Control', metaGroupID: ABYSSAL_META_GROUP_ID, metaLevel: 0 }),
  ]
  assert.equal(formatFamily(withAbyssal, 2048, false, blueprintOf).hasAbyssal, true)
  assert.equal(formatFamily(FAMILY, 2048, false, blueprintOf).hasAbyssal, false)
})
