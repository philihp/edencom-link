// What CCP holds for each type, remembered between page loads.
//
// The point is to stop a 400 before it is sent. Once a type's real variation
// list is known, every later icon for that type — this page, the next
// navigation, tomorrow's visit — resolves against the list and asks only for
// artwork that exists. Only a type we have never seen falls back to guessing.
//
// localStorage rather than IndexedDB: the whole store is a few tens of KB (one
// short array per type, against a ~5MB budget), and being *synchronous* is the
// feature — it can be read inside a render, which is what lets the right URL go
// into the <img> in the first place instead of being patched afterwards.
//
// Relative import with the extension: this module is unit-tested and the runner
// is plain Node, which resolves no '@/*' path alias.
import { parseVariations, variationsCacheKey, type IconVariation } from './iconVariation.ts'

// Only what this module uses, so a test can pass a plain object and so a
// partial/blocked Storage implementation still type-checks.
export type VariationStore = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

// Per-process memo in front of the store: repeated icons for one type parse
// their entry once, and it also serves the case where storage is unavailable
// (private browsing, storage disabled) — the cache then simply lasts one page.
const memo = new Map<number, IconVariation[]>()

// Reading localStorage throws outright in some configurations rather than
// returning null, so every access is guarded. On the server there is no
// localStorage at all, which is the case that keeps the server render
// deterministic.
export const browserStore = (): VariationStore | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

// The variations known for a type, or null if we have never learned them.
// Never returns an empty array: "known to have nothing" is not a state worth
// persisting, and treating it as unknown lets a later visit retry.
export const readVariations = (
  typeID: number,
  store: VariationStore | null = browserStore()
): IconVariation[] | null => {
  const remembered = memo.get(typeID)
  if (remembered) return remembered
  if (!store) return null
  try {
    const raw = store.getItem(variationsCacheKey(typeID))
    if (raw === null) return null
    // Stored by us, but it is still user-writable text: parse it with the same
    // defensiveness as CCP's response rather than trusting it into a URL.
    const variations = parseVariations(JSON.parse(raw))
    if (variations.length === 0) return null
    memo.set(typeID, variations)
    return variations
  } catch {
    // Malformed entry (hand-edited, truncated, an older shape) — treat it as
    // unknown and let the next successful lookup overwrite it.
    return null
  }
}

// Remember a type's variations for next time. Writes can throw on a full or
// blocked store; the memo still holds, so the page keeps working and only the
// persistence is lost.
export const writeVariations = (
  typeID: number,
  variations: readonly IconVariation[],
  store: VariationStore | null = browserStore()
): void => {
  if (variations.length === 0) return
  memo.set(typeID, [...variations])
  if (!store) return
  try {
    store.setItem(variationsCacheKey(typeID), JSON.stringify(variations))
  } catch {
    // Quota exceeded, or storage disabled mid-session. Not worth surfacing for
    // a decorative icon.
  }
}

// Test seam: the memo is module state, so a test that wants a cold cache says so.
export const clearVariationMemo = () => memo.clear()
