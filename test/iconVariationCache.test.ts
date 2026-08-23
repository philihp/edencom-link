import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

import { variationsCacheKey, type IconVariation } from '../src/app/iconVariation.ts'
import {
  clearVariationMemo,
  readVariations,
  writeVariations,
  type VariationStore,
} from '../src/app/iconVariationCache.ts'

// A stand-in for localStorage, so the store's behaviour — including the ways it
// misbehaves in real browsers — can be exercised without one.
const fakeStore = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } satisfies VariationStore & { data: Map<string, string> }
}

const throwingStore = (): VariationStore => ({
  getItem: () => {
    throw new Error('storage disabled')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
})

const RELIC: IconVariation[] = ['relic']

beforeEach(clearVariationMemo)

describe('readVariations', () => {
  it('is null for a type never seen, so the caller falls back to guessing', () => {
    assert.equal(readVariations(30618, fakeStore()), null)
  })

  it('reads back what was written, under a key carrying the type id', () => {
    const store = fakeStore()
    writeVariations(30618, RELIC, store)
    assert.ok(store.data.has(variationsCacheKey(30618)))
    assert.ok(variationsCacheKey(30618).includes('30618'))
    clearVariationMemo() // prove it came from the store, not the memo
    assert.deepEqual(readVariations(30618, store), RELIC)
  })

  it('serves later lookups from the memo, without touching the store again', () => {
    const store = fakeStore()
    writeVariations(587, ['render', 'icon'], store)
    let reads = 0
    const counting: VariationStore = {
      getItem: (k) => {
        reads += 1
        return store.getItem(k)
      },
      setItem: store.setItem,
    }
    readVariations(587, counting)
    readVariations(587, counting)
    assert.equal(reads, 0, 'the write already primed the memo')
  })

  it('treats a malformed entry as unknown rather than throwing into a render', () => {
    assert.equal(readVariations(1, fakeStore({ [variationsCacheKey(1)]: 'not json' })), null)
    assert.equal(readVariations(2, fakeStore({ [variationsCacheKey(2)]: '{"nope":1}' })), null)
  })

  it('drops entries whose contents are not variations we know', () => {
    // Stored by us, but still user-writable text — it must not reach a URL.
    assert.equal(readVariations(3, fakeStore({ [variationsCacheKey(3)]: '["wat","nope"]' })), null)
    assert.deepEqual(readVariations(4, fakeStore({ [variationsCacheKey(4)]: '["icon","wat"]' })), ['icon'])
  })

  it('treats an empty stored list as unknown, so a later visit retries', () => {
    assert.equal(readVariations(5, fakeStore({ [variationsCacheKey(5)]: '[]' })), null)
  })

  it('survives a store that throws on read', () => {
    assert.equal(readVariations(30618, throwingStore()), null)
  })

  it('is null with no store at all — the server render, which must stay deterministic', () => {
    assert.equal(readVariations(30618, null), null)
  })
})

describe('writeVariations', () => {
  it('does not persist an empty list', () => {
    const store = fakeStore()
    writeVariations(30618, [], store)
    assert.equal(store.data.size, 0)
    assert.equal(readVariations(30618, store), null)
  })

  it('keeps the answer for the page even when persisting throws', () => {
    writeVariations(30618, RELIC, throwingStore())
    assert.deepEqual(readVariations(30618, throwingStore()), RELIC, 'memo still serves it')
  })

  it('keeps the answer for the page when there is no store', () => {
    writeVariations(30618, RELIC, null)
    assert.deepEqual(readVariations(30618, null), RELIC)
  })

  it('stores a copy, so a later mutation of the caller array cannot corrupt it', () => {
    const store = fakeStore()
    const mutable: IconVariation[] = ['icon']
    writeVariations(9, mutable, store)
    mutable.push('render')
    assert.deepEqual(readVariations(9, store), ['icon'])
  })
})

describe('variationsCacheKey', () => {
  it('is distinct per type and carries a schema version', () => {
    assert.notEqual(variationsCacheKey(1), variationsCacheKey(2))
    assert.match(variationsCacheKey(30618), /^typeIcon\.variations\.1\.30618$/)
  })
})
