import assert from 'node:assert/strict'
import { test } from 'node:test'

import { DEFAULT_TAB, PLANNER_TABS, tabForPath, tabPath } from '../src/app/industry/planner/tabs.ts'

test('the tabs are in the order the owner listed them', () => {
  assert.deepEqual(
    PLANNER_TABS.map((t) => t.slug),
    ['margins', 'stock-types', 'invention', 'industry', 'market', 'settings']
  )
  assert.equal(DEFAULT_TAB.slug, 'margins')
})

test('a tab path is the planner path plus the slug', () => {
  assert.equal(tabPath(PLANNER_TABS[1]), '/industry/planner/stock-types')
})

test('tabForPath reads the tab from a pathname, deeper segments included', () => {
  assert.equal(tabForPath('/industry/planner/market')?.slug, 'market')
  assert.equal(tabForPath('/industry/planner/market/')?.slug, 'market')
  assert.equal(tabForPath('/industry/planner/settings/structures')?.slug, 'settings')
})

test('tabForPath is null off the planner or on an unknown tab', () => {
  assert.equal(tabForPath('/industry/planner'), null)
  assert.equal(tabForPath('/industry'), null)
  assert.equal(tabForPath('/industry/planner/nope'), null)
})
