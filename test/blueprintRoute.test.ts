// /blueprint/[id] dispatch (src/app/blueprint/blueprintRoute.ts): a type id
// or an item id, by magnitude.
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyBlueprintId, ITEM_ID_FLOOR } from '../src/app/blueprint/blueprintRoute.ts'

test('a type id is the rig page', () => {
  assert.deepEqual(classifyBlueprintId('787'), { kind: 'type', typeId: 787 })
  assert.deepEqual(classifyBlueprintId('999999'), { kind: 'type', typeId: 999999 })
})

test('a player item id is the item page', () => {
  assert.deepEqual(classifyBlueprintId('1018975246391'), { kind: 'item', itemId: 1018975246391 })
  assert.deepEqual(classifyBlueprintId(String(ITEM_ID_FLOOR)), { kind: 'item', itemId: ITEM_ID_FLOOR })
})

test('anything that is not a positive integer is invalid', () => {
  assert.deepEqual(classifyBlueprintId('abc'), { kind: 'invalid' })
  assert.deepEqual(classifyBlueprintId('12a'), { kind: 'invalid' })
  assert.deepEqual(classifyBlueprintId('-5'), { kind: 'invalid' })
  assert.deepEqual(classifyBlueprintId('0'), { kind: 'invalid' })
  assert.deepEqual(classifyBlueprintId(''), { kind: 'invalid' })
  assert.deepEqual(classifyBlueprintId('99999999999999999999'), { kind: 'invalid' })
})
