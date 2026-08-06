// Drift guard for the GraphQL SDL (src/app/api/graphql/schema.graphql.ts):
// the SDL lives in an I/O-free module precisely so this can build it with the
// plain `graphql` reference implementation and pin the query surface — a field
// someone renames or drops shows up here before an external stockpile UI
// breaks on it.
import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSchema, type GraphQLObjectType } from 'graphql'

import { typeDefs } from '../src/app/api/graphql/schema.graphql.ts'

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
