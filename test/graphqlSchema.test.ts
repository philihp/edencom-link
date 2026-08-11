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

// The three leaf-only entity types the row types point at.
const ENTITY_TYPES = ['ItemType', 'Location', 'Owner']

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

test('the SDL parses and exposes the expected query fields', () => {
  const schema = buildSchema(typeDefs)
  const query = schema.getQueryType() as GraphQLObjectType
  assert.deepEqual(Object.keys(query.getFields()).sort(), [
    'assets',
    'blueprints',
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
    assert.equal(String(fields.owner?.type), 'Owner!', `${name}.owner`)
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

test('every character-filtered field carries both the fuzzy character and the exact characters list', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  for (const name of ['assets', 'blueprints', 'industryJobs', 'marketOrders', 'walletTransactions']) {
    const args = new Map(fields[name].args.map((a) => [a.name, String(a.type)]))
    assert.equal(args.get('character'), 'String', `${name}.character`)
    // A list of characters — names, EVE character ids or registration ids —
    // and String for the same reason typeIds is: EVE ids overflow Int.
    assert.equal(args.get('characters'), '[String!]', `${name}.characters`)
    // The rows still say owner/ownerId/ownerName; only the FILTER is named for
    // what it takes. `owner:` as an argument is gone, not deprecated.
    assert.equal(args.get('owner'), undefined, `${name}.owner`)
    assert.equal(args.get('owners'), undefined, `${name}.owners`)
  }
})

test('the type-filtered fields all carry typeIds as a String list', () => {
  const schema = buildSchema(typeDefs)
  const fields = (schema.getQueryType() as GraphQLObjectType).getFields()
  for (const name of ['assets', 'blueprints', 'walletTransactions']) {
    const arg = fields[name].args.find((a) => a.name === 'typeIds')
    assert.ok(arg, `${name} has a typeIds arg`)
    // String, not Int: EVE type ids are small today but the schema keeps one
    // id representation, and Int is 32-bit.
    assert.equal(String(arg.type), '[String!]')
  }
})
