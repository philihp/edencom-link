import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { blueprintIcon, iconVariation } from '../src/app/iconVariation.ts'

// The expectations below were checked against CCP's own variations endpoint,
// GET https://images.evetech.net/types/{id}, which answers with the available
// variations as a JSON array. Recorded here rather than fetched — the suite is
// offline by construction (test/lib/offlineGuard.ts) — so a change in CCP's
// artwork shows up as a documented mismatch rather than a silent broken image.
//
//   Wrecked Armor Nanobot 30618 (category 34) -> ["relic"]
//   Rifter                  587 (category  6) -> ["render","icon"]
//   Moa Blueprint           691 (category  9) -> ["bpc","bp"]
//   Tritanium                34 (category  4) -> ["icon"]
describe('iconVariation', () => {
  it('sends Ancient Relics to relic — they have no icon at all', () => {
    assert.equal(iconVariation(34), 'relic')
  })

  it('sends blueprints to bp, and to bpc when the row says it is a copy', () => {
    assert.equal(iconVariation(9), 'bp')
    assert.equal(iconVariation(9, true), 'bpc')
    assert.equal(iconVariation(9, false), 'bp')
  })

  it('leaves every other category on icon, ships included', () => {
    assert.equal(iconVariation(6), 'icon')
    assert.equal(iconVariation(4), 'icon')
    assert.equal(iconVariation(7), 'icon')
  })

  it('falls back to icon when the category is unknown', () => {
    // A type the published-type view does not cover resolves to undefined; the
    // safe guess is the variation almost everything has.
    assert.equal(iconVariation(undefined), 'icon')
    assert.equal(iconVariation(null), 'icon')
  })

  it('ignores isBlueprintCopy outside the blueprint category', () => {
    // A relic is never a copy; a stray flag must not turn it into bpc.
    assert.equal(iconVariation(34, true), 'relic')
    assert.equal(iconVariation(4, true), 'icon')
  })
})

describe('blueprintIcon', () => {
  it('maps copy-ness to the two blueprint variations', () => {
    assert.equal(blueprintIcon(true), 'bpc')
    assert.equal(blueprintIcon(false), 'bp')
    assert.equal(blueprintIcon(null), 'bp')
    assert.equal(blueprintIcon(undefined), 'bp')
  })
})
