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
    'walletBalances',
    'walletTransactions',
  ])
})

test('ids stay String — EVE item ids overflow GraphQL Int', () => {
  const schema = buildSchema(typeDefs)
  const asset = schema.getType('Asset') as GraphQLObjectType
  assert.equal(String(asset.getFields().itemId.type), 'String!')
  assert.equal(String(asset.getFields().quantity.type), 'String!')
  const order = schema.getType('MarketOrder') as GraphQLObjectType
  assert.equal(String(order.getFields().orderId.type), 'String!')
})
