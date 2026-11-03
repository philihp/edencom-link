// The asset browser's link rule (src/app/asset/itemHref.ts): a page only for
// an item that is one of a kind.
import assert from 'node:assert/strict'
import test from 'node:test'

import { itemHref } from '../src/app/asset/itemHref.ts'

const SHIP = 6
const BLUEPRINT = 9
const MODULE = 7

test('an assembled hull is a ship', () => {
  assert.equal(itemHref({ itemId: 1001, categoryId: SHIP, isSingleton: true, contents: 0 }), '/ship/1001')
  assert.equal(itemHref({ itemId: 1001, categoryId: SHIP, isSingleton: true, contents: 12 }), '/ship/1001')
})

test('a packaged hull is a stack, not a ship', () => {
  assert.equal(itemHref({ itemId: 1002, categoryId: SHIP, isSingleton: false, contents: 0 }), null)
  assert.equal(itemHref({ itemId: 1002, categoryId: SHIP, isSingleton: null, contents: 0 }), null)
})

test('a blueprint, original or copy, has its own page', () => {
  assert.equal(itemHref({ itemId: 1003, categoryId: BLUEPRINT, isSingleton: true, contents: 0 }), '/blueprint/1003')
})

test('a packaged blueprint falls through to the stack rule', () => {
  assert.equal(itemHref({ itemId: 1004, categoryId: BLUEPRINT, isSingleton: false, contents: 0 }), null)
})

test('a container is anything holding items', () => {
  assert.equal(itemHref({ itemId: 1005, categoryId: null, isSingleton: true, contents: 3 }), '/asset/1005')
  assert.equal(itemHref({ itemId: 1006, categoryId: MODULE, isSingleton: false, contents: 1 }), '/asset/1006')
})

test('a plain stack goes nowhere', () => {
  assert.equal(itemHref({ itemId: 1007, categoryId: MODULE, isSingleton: false, contents: 0 }), null)
  assert.equal(itemHref({ itemId: 1007, categoryId: null, isSingleton: null, contents: 0 }), null)
})

test('every other singleton — a fitted module, an empty can — is /asset, where its memory is read', () => {
  assert.equal(itemHref({ itemId: 1008, categoryId: MODULE, isSingleton: true, contents: 0 }), '/asset/1008')
  assert.equal(itemHref({ itemId: 1009, categoryId: 2, isSingleton: true, contents: 0 }), '/asset/1009')
})

test('string ids pass through unchanged', () => {
  assert.equal(
    itemHref({ itemId: '1018975246391', categoryId: SHIP, isSingleton: true, contents: 0 }),
    '/ship/1018975246391'
  )
})
