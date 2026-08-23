import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  blueprintIcon,
  iconVariation,
  parseVariations,
  pickVariation,
  preferenceFor,
  type IconVariation,
} from '../src/app/iconVariation.ts'

// The available-variation sets below are what CCP's own endpoint returns —
// GET https://images.evetech.net/types/{id}, a JSON array. Recorded rather than
// fetched, since the suite is offline by construction (test/lib/offlineGuard).
const RELIC: IconVariation[] = ['relic'] // Wrecked Armor Nanobot 30618
const SHIP: IconVariation[] = ['render', 'icon'] // Rifter 587
const BLUEPRINT: IconVariation[] = ['bpc', 'bp'] // Moa Blueprint 691
const PLAIN: IconVariation[] = ['icon'] // Tritanium 34

describe('pickVariation', () => {
  it('prefers icon whenever the type has the choice', () => {
    assert.equal(pickVariation(SHIP, preferenceFor()), 'icon')
    assert.equal(pickVariation(PLAIN, preferenceFor()), 'icon')
  })

  it('falls through to the only artwork a relic has', () => {
    assert.equal(pickVariation(RELIC, preferenceFor()), 'relic')
  })

  it('takes bp for a blueprint, and bpc once told it is a copy', () => {
    assert.equal(pickVariation(BLUEPRINT, preferenceFor()), 'bp')
    assert.equal(pickVariation(BLUEPRINT, preferenceFor(null, true)), 'bpc')
  })

  it('gives render only when render is asked for', () => {
    assert.equal(pickVariation(SHIP, preferenceFor()), 'icon')
    assert.equal(pickVariation(SHIP, preferenceFor('render')), 'render')
  })

  it('honours a full priority list, best available first', () => {
    assert.equal(pickVariation(SHIP, preferenceFor(['bpc', 'render', 'icon'])), 'render')
    assert.equal(pickVariation(PLAIN, preferenceFor(['bpc', 'render', 'icon'])), 'icon')
  })

  it('still resolves when the hint names nothing the type has', () => {
    // A hint is a preference, not a filter — the house order follows it, so an
    // inapplicable hint degrades to the normal answer instead of no image.
    assert.equal(pickVariation(RELIC, preferenceFor('render')), 'relic')
    assert.equal(pickVariation(PLAIN, preferenceFor('bpc')), 'icon')
  })

  it('takes whatever exists when the preference matches none of it', () => {
    assert.equal(pickVariation(['render'], ['bp']), 'render')
  })

  it('is null for a type the image server holds nothing for', () => {
    assert.equal(pickVariation([], preferenceFor()), null)
  })
})

describe('preferenceFor', () => {
  it('leads with the hint and keeps the house order behind it', () => {
    assert.deepEqual(preferenceFor('render'), ['render', 'icon', 'bp', 'relic', 'bpc'])
  })

  it('does not repeat a hint that is already in the house order', () => {
    const preference = preferenceFor('icon')
    assert.equal(new Set(preference).size, preference.length)
  })

  it('swaps the blueprint pair for a copy', () => {
    assert.deepEqual(preferenceFor(null, true), ['icon', 'bpc', 'bp', 'relic', 'render'])
  })
})

describe('parseVariations', () => {
  it("reads CCP's array", () => {
    assert.deepEqual(parseVariations(['bpc', 'bp']), ['bpc', 'bp'])
  })

  it('drops anything it does not recognise rather than trusting it into a URL', () => {
    assert.deepEqual(parseVariations(['icon', 'wat', 42, null]), ['icon'])
  })

  it('is empty for a shape that is not an array at all', () => {
    assert.deepEqual(parseVariations({ variations: ['icon'] }), [])
    assert.deepEqual(parseVariations(null), [])
    assert.deepEqual(parseVariations('icon'), [])
  })
})

describe('iconVariation (the opening guess)', () => {
  it('guesses relic for Ancient Relics and bp/bpc for blueprints', () => {
    assert.equal(iconVariation(34), 'relic')
    assert.equal(iconVariation(9), 'bp')
    assert.equal(iconVariation(9, true), 'bpc')
  })

  it('guesses icon for everything else, ships included', () => {
    assert.equal(iconVariation(6), 'icon')
    assert.equal(iconVariation(undefined), 'icon')
    assert.equal(iconVariation(null), 'icon')
  })

  it('ignores isBlueprintCopy outside the blueprint category', () => {
    assert.equal(iconVariation(34, true), 'relic')
    assert.equal(iconVariation(4, true), 'icon')
  })

  it('agrees with what the endpoint actually returns for each sampled type', () => {
    // The guess only has to be *available*; the component verifies the rest.
    assert.ok(RELIC.includes(iconVariation(34)))
    assert.ok(BLUEPRINT.includes(iconVariation(9)))
    assert.ok(SHIP.includes(iconVariation(6)))
    assert.ok(PLAIN.includes(iconVariation(4)))
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
