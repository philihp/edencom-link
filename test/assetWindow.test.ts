// The /asset value chart's own window options (src/app/asset/assetWindow.ts).
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ASSET_WINDOW_OPTIONS,
  DEFAULT_ASSET_WINDOW_DAYS,
  isAssetWindowDays,
  LONGEST_ASSET_WINDOW_DAYS,
  monthlyTicks,
} from '../src/app/asset/assetWindow.ts'

test('the asset window drops 1 and 3 days and adds 1, 2 and 30 years', () => {
  assert.deepEqual(
    ASSET_WINDOW_OPTIONS.map((o) => o.label),
    ['7 days', '14 days', '30 days', '90 days', '1 year', '2 years', '30 years']
  )
  assert.equal(isAssetWindowDays(1), false)
  assert.equal(isAssetWindowDays(3), false)
  assert.equal(isAssetWindowDays(365), true)
  assert.equal(isAssetWindowDays(730), true)
  assert.equal(LONGEST_ASSET_WINDOW_DAYS, 30 * 365)
  assert.ok(isAssetWindowDays(DEFAULT_ASSET_WINDOW_DAYS))
})

test('a window past a quarter labels its axis by month', () => {
  assert.equal(monthlyTicks(90), false)
  assert.equal(monthlyTicks(365), true)
})
