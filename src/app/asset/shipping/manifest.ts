// Turning a pasted block of text into the lines an appraisal sends upstream.
//
// The pure half of the shipping calculator: everything here is string work, so
// what counts as an item, a quantity, or a line to ignore is unit-testable
// without innomin.at or kumgo.space (see test/shippingManifest.test.ts). The
// action next door does the I/O.
//
// Relative + .ts, like assetLines.ts and rigs.ts: `pnpm test` runs Node's
// stripped-types loader, which resolves no path aliases.
import { reduce } from 'ramda'

import { MAX_LINES } from '../../api/appraisal/assetLines.ts'

export type ManifestLine = { name: string; quantity: number }

export type ParsedManifest = {
  // Merged by name, in first-seen order — one appraisal is one upstream
  // request, so the same item pasted twice must not become two lines.
  lines: ManifestLine[]
  // Lines deliberately dropped (fitting headers and the like), reported back
  // so the page can say what it skipped rather than silently eating input.
  ignored: string[]
}

// One appraisal is always exactly one upstream request (see assetLines.ts), so
// the same ceiling applies to a pasted list as to a walked hangar.
export { MAX_LINES }

// A fitting paste opens with "[Rifter, My Fit]" — a header, not an item.
const FITTING_HEADER = /^\[.*\]$/

// A count: either bare digits, or digit groups separated by whatever the
// client's locale uses for thousands (comma, apostrophe, a space of some
// width). The grouped form is spelled out rather than "digits and separators
// in any arrangement" so a space only reads as a separator when exactly three
// digits follow it — otherwise "Mexallon 1 234" would quietly become 234 of
// something called "Mexallon 1", and being wrong about how much cargo there is
// quotes the wrong freighter.
const COUNT = String.raw`(?:\d{1,3}(?:[,'\u00a0\u202f ]\d{3})+|\d+)`

// "Tritanium 1,000", "Tritanium x1000" — the count trails the name, optionally
// x-prefixed. A name ending in digits is safe: they're never preceded by a
// space ("Zainou 'Gypsy' KNS-1000", "425mm AutoCannon II").
const TRAILING_QUANTITY = new RegExp(String.raw`^(.*?\S)\s+x?\s*(${COUNT})$`, 'i')
// "1000x Tritanium" — the other way round, as multibuy also accepts.
const LEADING_QUANTITY = new RegExp(String.raw`^(${COUNT})\s*x\s+(.*\S)$`, 'i')

// Thousands separators vary by client locale (comma, apostrophe, thin space);
// none of them survive into the number. Anything that isn't a whole positive
// count isn't a quantity at all — the caller then keeps the token as part of
// the item name rather than guessing.
const parseQuantity = (raw: string): number | null => {
  const cleaned = raw.replace(/[,'\s\u00a0\u202f]/g, '')
  if (!/^[0-9]+$/.test(cleaned)) return null
  const quantity = Number(cleaned)
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null
}

// One line → an item and how many, or null if there's nothing on it. The three
// shapes a player can paste, in the order they're told apart:
//
//   1. An inventory copy, tab-separated: name, quantity, group, category, …
//   2. Multibuy, "name quantity" / "name xquantity" / "quantity x name"
//   3. A bare name (a fitting or contract paste) — one of it
const parseLine = (line: string): ManifestLine | null => {
  const trimmed = line.trim()
  if (trimmed === '' || FITTING_HEADER.test(trimmed)) return null

  // The inventory paste is unambiguous — the columns say which field is which
  // — so it's tested first and never falls through to the name heuristics.
  if (line.includes('\t')) {
    const cells = line.split('\t')
    const name = cells[0].trim()
    if (name === '') return null
    // A singleton (an assembled ship, a fitted module) pastes with an empty
    // quantity column rather than a 1.
    return { name, quantity: parseQuantity(cells[1] ?? '') ?? 1 }
  }

  const trailing = TRAILING_QUANTITY.exec(trimmed)
  const trailingQuantity = trailing ? parseQuantity(trailing[2]) : null
  if (trailing && trailingQuantity != null) return { name: trailing[1].trim(), quantity: trailingQuantity }

  const leading = LEADING_QUANTITY.exec(trimmed)
  const leadingQuantity = leading ? parseQuantity(leading[1]) : null
  if (leading && leadingQuantity != null) return { name: leading[2].trim(), quantity: leadingQuantity }

  return { name: trimmed, quantity: 1 }
}

// Names are merged case-insensitively (the paste may mix an inventory copy with
// something typed by hand) but the first spelling seen is what gets sent, since
// that's the one the player will recognise in the unpriced list.
export const parseManifest = (raw: string): ParsedManifest => {
  const merged = new Map<string, ManifestLine>()
  const ignored: string[] = []

  reduce(
    (_acc, line: string) => {
      const parsed = parseLine(line)
      if (parsed == null) {
        const trimmed = line.trim()
        if (trimmed !== '') ignored.push(trimmed)
        return _acc
      }
      const key = parsed.name.toLowerCase()
      const existing = merged.get(key)
      merged.set(key, { name: existing?.name ?? parsed.name, quantity: (existing?.quantity ?? 0) + parsed.quantity })
      return _acc
    },
    null,
    raw.split(/\r?\n/)
  )

  return { lines: [...merged.values()], ignored }
}
