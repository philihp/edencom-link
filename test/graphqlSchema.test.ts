// Drift guard for the GraphQL SDL (src/app/api/graphql/schema.graphql.ts):
// the SDL lives in an I/O-free module precisely so this can build it with the
// plain `graphql` reference implementation and pin the query surface — a field
// someone renames or drops shows up here before an external stockpile UI
// breaks on it.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSchema,
  getNamedType,
  isInputObjectType,
  isObjectType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
} from 'graphql'

import { typeDefs } from '../src/app/api/graphql/schema.graphql.ts'

// The leaf-only entity types the row types point at.
const ENTITY_TYPES = ['Character', 'Corporation', 'ItemType', 'Location']

// Rows a corporation can own: their owner edge is nullable and paired with a
// corporation edge, with ownerType saying which side a row came from.
const CORP_OWNABLE = ['Asset', 'Blueprint', 'IndustryJob']

// Every type whose values are rows of a result set — except RestockLine, which
// is deliberately absent: it's the schema's one AGGREGATE row, summing stacks
// that may span two characters and a corp hangar, so it carries no owner block
// for the uniformity test below to check. See the restock tests at the bottom.
const ROW_TYPES = [
  'Asset',
  'Blueprint',
  'IndustryJob',
  'MarketOrder',
  'ShareGrant',
  'WalletBalance',
  'WalletTransaction',
]

const objectType = (schema: GraphQLSchema, name: string): GraphQLObjectType => {
  const type: GraphQLNamedType | undefined = schema.getType(name) ?? undefined
  assert.ok(type && isObjectType(type), `${name} is an object type`)
  return type
}

// The owner pair is uniform even where only characters can own a row: corp
// market orders have no ESI extract behind them (no corp_order table), so
// marketOrders takes the same owner filter and REFUSES a corporation-only one
// at run time (resolvers.ts) rather than dropping the argument.
test('the owner filter is on every list, including the character-only ones', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  for (const name of ['assets', 'blueprints', 'industryJobs', 'marketOrders', 'restock', 'walletTransactions']) {
    const args = new Map(fields[name].args.map((a) => [a.name, String(a.type)]))
    assert.equal(args.get('owner'), 'String', `${name}.owner`)
    assert.equal(args.get('owners'), '[String!]', `${name}.owners`)
  }
})

test('the SDL parses and exposes the expected query fields', () => {
  const schema = buildSchema(typeDefs)
  const query = schema.getQueryType() as GraphQLObjectType
  assert.deepEqual(Object.keys(query.getFields()).sort(), [
    'assets',
    'blueprints',
    'characters',
    'corporations',
    'industryJobs',
    'marketOrders',
    'restock',
    'sharedWithMe',
    'walletBalances',
    'walletTransactions',
  ])
})

test('assets carries the opt-in includeShared arg, default false', () => {
  const schema = buildSchema(typeDefs)
  const query = schema.getQueryType() as GraphQLObjectType
  const arg = query.getFields().assets.args.find((a) => a.name === 'includeShared')
  assert.ok(arg)
  // Read the default off the SDL ast — the runtime defaultValue representation
  // differs across graphql-js majors, the source of truth doesn't.
  const defaultNode = arg.astNode?.defaultValue
  assert.ok(defaultNode?.kind === 'BooleanValue' && defaultNode.value === false)
})

test('ids stay String — EVE item ids overflow GraphQL Int', () => {
  const schema = buildSchema(typeDefs)
  const asset = schema.getType('Asset') as GraphQLObjectType
  assert.equal(String(asset.getFields().itemId.type), 'String!')
  assert.equal(String(asset.getFields().quantity.type), 'String!')
  const order = schema.getType('MarketOrder') as GraphQLObjectType
  assert.equal(String(order.getFields().orderId.type), 'String!')
})

// The invariant the whole entity-edge design rests on: because the entity types
// bottom out in scalars, a response is at most row → entity → scalar, so
// src/app/lens/flatten.ts can flatten any row to one CSV line by joining one
// level of keys. Adding an object field to Owner/ItemType/Location silently
// breaks CSV export (and opens the deep-query surface the flat design avoids) —
// so it breaks here first.
test('the entity types are leaf-only, which is what keeps rows CSV-flattenable', () => {
  const schema = buildSchema(typeDefs)
  for (const name of ENTITY_TYPES) {
    for (const field of Object.values(objectType(schema, name).getFields())) {
      const target = getNamedType(field.type)
      assert.ok(
        !isObjectType(target),
        `${name}.${field.name} points at the object type ${target.name} — entity types must hold scalars only`
      )
    }
  }
})

test('every row spells out its owner the same way, and points only at entity types', () => {
  const schema = buildSchema(typeDefs)
  for (const name of ROW_TYPES) {
    const fields = objectType(schema, name).getFields()
    // The flat block is uniform: ownerType/ownerId/ownerName always filled,
    // the character columns filled only on a character-owned row.
    assert.equal(String(fields.ownerType?.type), 'String!', `${name}.ownerType`)
    assert.equal(String(fields.ownerId?.type), 'String!', `${name}.ownerId`)
    assert.equal(String(fields.ownerName?.type), 'String!', `${name}.ownerName`)
    assert.equal(String(fields.characterId?.type), 'String', `${name}.characterId`)
    assert.equal(String(fields.characterName?.type), 'String', `${name}.characterName`)
    assert.equal(String(fields.character?.type), 'Character', `${name}.character`)
    // The corporation columns exist only where a corporation can own the row —
    // a column that could never be filled would be worse than its absence.
    if (CORP_OWNABLE.includes(name)) {
      assert.equal(String(fields.corporationId?.type), 'String', `${name}.corporationId`)
      assert.equal(String(fields.corporationName?.type), 'String', `${name}.corporationName`)
      assert.equal(String(fields.corporation?.type), 'Corporation', `${name}.corporation`)
    } else {
      assert.equal(fields.corporationId, undefined, `${name}.corporationId`)
      assert.equal(fields.corporation, undefined, `${name}.corporation`)
    }
    // `owner` as an EDGE is gone: it meant the character while ownerName meant
    // either, one field apart. The scalars are the umbrella now.
    assert.equal(fields.owner, undefined, `${name}.owner`)
    for (const field of Object.values(fields)) {
      const target = getNamedType(field.type)
      if (!isObjectType(target)) continue
      assert.ok(
        ENTITY_TYPES.includes(target.name),
        `${name}.${field.name} points at the non-entity type ${target.name}`
      )
    }
  }
})

// The edges are additive: a caller querying the flat scalars must keep working,
// and a CSV-shaped query must stay writable without touching a nested selection.
test('the flat scalar beside each edge survives', () => {
  const schema = buildSchema(typeDefs)
  const asset = objectType(schema, 'Asset').getFields()
  assert.equal(String(asset.characterName.type), 'String')
  assert.equal(String(asset.typeName.type), 'String')
  assert.equal(String(asset.locationName.type), 'String')
  const job = objectType(schema, 'IndustryJob').getFields()
  assert.equal(String(job.blueprintTypeName.type), 'String')
  assert.equal(String(job.productTypeName.type), 'String')
})

test('Character exposes the EVE character id distinctly from the registration id', () => {
  const schema = buildSchema(typeDefs)
  const character = objectType(schema, 'Character').getFields()
  // id is the registration uuid (an owner filter accepts it); characterId is
  // the EVE numeric id, and what the row's characterId/ownerId carry.
  // Conflating them is the legacy wart docs/registration-id-rename.md exists to
  // unwind — the schema states it.
  assert.equal(String(character.id.type), 'String!')
  assert.equal(String(character.characterId.type), 'String')
  assert.ok(character.id.description?.includes('registration id'))
})

// restock is the first field to take a structured input and the first to
// return an aggregate. Both are easy to erode: an extra object field on
// RestockLine would break CSV flattening, and a widened target input would let
// a lens ask for a sum nobody can reproduce.
test('restock takes a required list of RestockTargets and defaults to below-target only', () => {
  const schema = buildSchema(typeDefs)
  const field = (schema.getQueryType() as GraphQLObjectType).getFields().restock
  assert.equal(String(field.type), '[RestockLine!]!')

  const args = new Map(field.args.map((a) => [a.name, a]))
  assert.equal(String(args.get('targets')?.type), '[RestockTarget!]!')
  // Read the default off the SDL ast, like the includeShared test above.
  const defaultNode = args.get('onlyBelowTarget')?.astNode?.defaultValue
  assert.ok(defaultNode?.kind === 'BooleanValue' && defaultNode.value === true)

  const target = schema.getType('RestockTarget')
  assert.ok(target && isInputObjectType(target), 'RestockTarget is an input type')
  const fields = target.getFields()
  assert.equal(String(fields.type.type), 'String!')
  // The wanted quantity is an Int (a caller types it); the SUMS are strings,
  // since on-hand of a mineral overflows 32 bits long before the target does.
  assert.equal(String(fields.quantity.type), 'Int!')
})

test('a restock line is an aggregate: no owner block, and its sums are strings', () => {
  const schema = buildSchema(typeDefs)
  const fields = objectType(schema, 'RestockLine').getFields()
  for (const column of ['target', 'onHand', 'delta', 'toBuy']) {
    assert.equal(String(fields[column]?.type), 'String!', `RestockLine.${column}`)
  }
  // A summed line spans owners, so naming one would be a lie.
  for (const absent of ['ownerType', 'ownerId', 'ownerName', 'character', 'corporation']) {
    assert.equal(fields[absent], undefined, `RestockLine.${absent}`)
  }
  // The CSV invariant: one object edge, pointing at a leaf-only entity type.
  const edges = Object.values(fields).filter((f) => isObjectType(getNamedType(f.type)))
  assert.deepEqual(
    edges.map((f) => `${f.name}: ${getNamedType(f.type).name}`),
    ['type: ItemType']
  )
})

test('every filter dimension is a singular/plural pair, and the old names are gone', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  // Which dimensions each field filters on — the pairs are uniform, the set of
  // dimensions is per field (only assets carries a location). Owner is one
  // dimension spanning characters and corporations, not two.
  const dimensions: Record<string, string[]> = {
    assets: ['type', 'location', 'owner'],
    blueprints: ['type', 'owner'],
    industryJobs: ['owner'],
    marketOrders: ['owner'],
    // No type pair on restock — its targets carry the types, and a second way
    // to name them would be a filter that silently disagreed with the list.
    restock: ['location', 'owner'],
    walletTransactions: ['type', 'owner'],
  }
  for (const [field, dims] of Object.entries(dimensions)) {
    const args = new Map(fields[field].args.map((a) => [a.name, String(a.type)]))
    for (const dim of dims) {
      assert.equal(args.get(dim), 'String', `${field}.${dim}`)
      // A list of ids or whole names — String for the same reason every id in
      // this schema is: EVE ids overflow GraphQL's 32-bit Int.
      assert.equal(args.get(`${dim}s`), '[String!]', `${field}.${dim}s`)
    }
    // The pre-pairing spellings, all removed rather than deprecated.
    for (const gone of [
      'character',
      'characters',
      'corporation',
      'corporations',
      'typeIds',
      'typeName',
      'locationId',
      'locationIds',
    ]) {
      assert.equal(args.get(gone), undefined, `${field}.${gone}`)
    }
  }
})
