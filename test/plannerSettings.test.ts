import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_SETTINGS,
  facilityTaxRate,
  fromRow,
  parseBuildBuy,
  parseSettingsForm,
  toPercent,
  toRow,
} from '../src/app/industry/planner/settings/settings.ts'

const form = {
  homeMarket: 'C-J6MT',
  overbuild: '50',
  minimumMargin: '5',
  marketFees: '5',
  sccTax: '4',
  haulImport: '900',
  haulExport: '900',
}

test('a missing row reads as the defaults', () => {
  assert.deepEqual(fromRow(null), DEFAULT_SETTINGS)
  assert.deepEqual(fromRow(undefined), DEFAULT_SETTINGS)
})

test('a stored row reads its numeric strings as numbers, and toRow inverts fromRow', () => {
  const row = {
    overbuild: '0.25000',
    minimum_margin: '-0.10000',
    market_fees: '0.03600',
    scc_tax: '0.04000',
    home_market: 'C-J6MT',
    haul_import: '850.00',
    haul_export: '1000.00',
  }
  const s = fromRow(row)
  assert.equal(s.overbuild, 0.25)
  assert.equal(s.minimumMargin, -0.1)
  assert.equal(s.haulImport, 850)
  assert.deepEqual(fromRow(toRow(s)), s)
})

test('the form reads percents as fractions and ISK as ISK', () => {
  const r = parseSettingsForm(form)
  assert.ok('settings' in r)
  assert.deepEqual(r.settings, DEFAULT_SETTINGS)
})

test('the form refuses a blank, a word, an out-of-range value and an unknown market', () => {
  assert.deepEqual(parseSettingsForm({ ...form, overbuild: '' }), {
    error: 'Enter a value for component overbuild.',
  })
  assert.deepEqual(parseSettingsForm({ ...form, sccTax: 'four' }), { error: 'SCC industry tax must be a number.' })
  assert.deepEqual(parseSettingsForm({ ...form, marketFees: '101' }), {
    error: 'Market fees must be between 0 and 100.',
  })
  assert.deepEqual(parseSettingsForm({ ...form, haulExport: '-1' }), {
    error: 'Export haul to Jita must be between 0 and 1000000000.',
  })
  assert.deepEqual(parseSettingsForm({ ...form, homeMarket: 'Amarr' }), {
    error: 'Choose a home market from the list.',
  })
})

test('a negative minimum margin is allowed', () => {
  const r = parseSettingsForm({ ...form, minimumMargin: '-20' })
  assert.ok('settings' in r)
  assert.equal(r.settings.minimumMargin, -0.2)
})

test('toPercent shows a fraction without float noise', () => {
  assert.equal(toPercent(0.07), 7)
  assert.equal(toPercent(0.001), 0.1)
})

test('parseBuildBuy takes build or buy in any case and refuses the rest', () => {
  assert.equal(parseBuildBuy('Build'), 'build')
  assert.equal(parseBuildBuy(' buy '), 'buy')
  assert.equal(parseBuildBuy('Buid'), null)
  assert.equal(parseBuildBuy(null), null)
})

test('facilityTaxRate is the own rate only where one of our corporations owns the structure', () => {
  const rates = { own: 0.001, public: 0.0983 }
  const ours = new Set([98000001])
  assert.equal(facilityTaxRate(98000001, ours, rates), 0.001)
  assert.equal(facilityTaxRate(98000002, ours, rates), 0.0983)
  assert.equal(facilityTaxRate(null, ours, rates), 0.0983)
})
