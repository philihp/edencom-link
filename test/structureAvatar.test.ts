import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { colourOf, initialsOf } from '../src/app/structure/avatar.ts'

describe('initialsOf', () => {
  it('takes the first letter of the first two words', () => {
    assert.equal(initialsOf('Aria Valis'), 'AV')
    assert.equal(initialsOf('Marrek Oskold Third'), 'MO')
  })

  it('gives one letter for a one-word name', () => {
    assert.equal(initialsOf('Kessandra'), 'K')
  })

  it('upper-cases and survives stray whitespace', () => {
    assert.equal(initialsOf('  tolen   marr '), 'TM')
  })

  it('draws nothing for an empty name', () => {
    assert.equal(initialsOf(''), '')
    assert.equal(initialsOf('   '), '')
  })
})

describe('colourOf', () => {
  it('is stable for the same name', () => {
    assert.equal(colourOf('Aria Valis'), colourOf('Aria Valis'))
  })

  it('is an hsl colour with a hue inside the wheel', () => {
    const m = colourOf('Kessandra Vor').match(/^hsl\((\d+) 28% 46%\)$/)
    assert.ok(m, 'hsl shape')
    const hue = Number(m![1])
    assert.ok(hue >= 0 && hue < 360)
  })

  it('separates names that differ', () => {
    assert.notEqual(colourOf('Aria Valis'), colourOf('Tolen Marr'))
  })
})
