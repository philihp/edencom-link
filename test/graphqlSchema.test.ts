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
  isObjectType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
} from 'graphql'

import { typeDefs } from '../src/app/api/graphql/schema.graphql.ts'

// The leaf-only entity types the row types point at.
const ENTITY_TYPES = ['Corporation', 'ItemType', 'Location', 'Owner']

// Rows a corporation can own: their owner edge is nullable and paired with a
// corporation edge, with ownerType saying which side a row came from.
const CORP_OWNABLE = ['Asset', 'Blueprint', 'IndustryJob']

// Every type whose values are rows of a result set.
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

// Corp market orders have no ESI extract behind them (no corp_order table), so
// marketOrders deliberately carries no corporation filter — an argument that
// could never match would be worse than its absence.
test('marketOrders and walletTransactions stay character-only', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  for (const name of ['marketOrders', 'walletTransactions']) {
    const args = fields[name].args.map((a) => a.name)
    assert.ok(args.includes('character'), `${name}.character`)
    assert.ok(!args.includes('corporation'), `${name}.corporation`)
    assert.ok(!args.includes('corporations'), `${name}.corporations`)
  }
})

test('the SDL parses and exposes the expected query fields', () => {
  const schema = buildSchema(typeDefs)
  const query = schema.getQueryType() as GraphQLObjectType
  assert.deepEqual(Object.keys(query.getFields()).sort(), [
    'assets',
    'blueprints',
    'corporations',
    'industryJobs',
    'marketOrders',
    'owners',
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

test('every row type carries an owner edge, and every object field on one is an entity type', () => {
  const schema = buildSchema(typeDefs)
  for (const name of ROW_TYPES) {
    const fields = objectType(schema, name).getFields()
    // A row only a character can own keeps a non-null owner; a corp-ownable
    // row has exactly one of owner/corporation filled, so both are nullable
    // and ownerType (never null) says which.
    if (CORP_OWNABLE.includes(name)) {
      assert.equal(String(fields.owner?.type), 'Owner', `${name}.owner`)
      assert.equal(String(fields.corporation?.type), 'Corporation', `${name}.corporation`)
      assert.equal(String(fields.ownerType?.type), 'String!', `${name}.ownerType`)
      assert.equal(String(fields.ownerId?.type), 'String!', `${name}.ownerId`)
      assert.equal(String(fields.ownerName?.type), 'String!', `${name}.ownerName`)
    } else {
      assert.equal(String(fields.owner?.type), 'Owner!', `${name}.owner`)
      assert.equal(fields.corporation, undefined, `${name}.corporation`)
    }
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
  assert.equal(String(asset.ownerName.type), 'String!')
  assert.equal(String(asset.typeName.type), 'String')
  assert.equal(String(asset.locationName.type), 'String')
  const job = objectType(schema, 'IndustryJob').getFields()
  assert.equal(String(job.blueprintTypeName.type), 'String')
  assert.equal(String(job.productTypeName.type), 'String')
})

test('Owner exposes the EVE character id distinctly from the registration id', () => {
  const schema = buildSchema(typeDefs)
  const owner = objectType(schema, 'Owner').getFields()
  // id is the registration uuid (what ownerId carries and `characters:` accepts);
  // characterId is the EVE numeric id. Conflating them is the legacy wart
  // docs/registration-id-rename.md exists to unwind — the schema states it.
  assert.equal(String(owner.id.type), 'String!')
  assert.equal(String(owner.characterId.type), 'String')
  assert.ok(owner.id.description?.includes('registration id'))
})

test('every filter dimension is a singular/plural pair, and the old names are gone', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  // Which dimensions each field filters on — the pairs are uniform, the set of
  // dimensions is per field (only assets carries a location).
  const dimensions: Record<string, string[]> = {
    assets: ['type', 'location', 'character', 'corporation'],
    blueprints: ['type', 'character', 'corporation'],
    industryJobs: ['character', 'corporation'],
    marketOrders: ['character'],
    walletTransactions: ['type', 'character'],
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
    for (const gone of ['owner', 'owners', 'typeIds', 'typeName', 'locationId', 'locationIds']) {
      assert.equal(args.get(gone), undefined, `${field}.${gone}`)
    }
  }
})
