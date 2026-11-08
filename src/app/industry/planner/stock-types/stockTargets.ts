// The stock directive's pure rules: what a line is, how a typed quantity is
// read, and the total EIV the list adds up to. No I/O, so
// test/plannerStockTargets.test.ts runs it under the node test runner.
import { reduce } from 'ramda'

// One line of the directive: an item type and how many to hold in general
// supply, in the home market and in Jita (the sheet's three columns).
export type StockTarget = { typeId: number; backup: number; home: number; jita: number }

export const QUANTITY_COLUMNS = ['backup', 'home', 'jita'] as const
export type QuantityColumn = (typeof QUANTITY_COLUMNS)[number]

// A quantity typed into a cell: a whole number of items, never below zero. A
// blank cell is zero, and anything that is not a whole number is refused
// (null) rather than rounded, since a rounded target is a silent change.
export const parseQuantity = (raw: string | number | null | undefined): number | null => {
  if (raw === null || raw === undefined) return 0
  const text = String(raw).trim()
  if (text === '') return 0
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

// Every unit the line asks for, across the three places.
export const targetTotal = (t: StockTarget): number => t.backup + t.home + t.jita

export type EivTotal = {
  // Σ quantity × CCP adjusted price, over the lines with a price.
  eiv: number
  // Lines whose type has no adjusted price on record; their units are not in eiv.
  unpriced: number
}

// The list's estimated item value: every unit it asks for, at CCP's adjusted
// price for the type (the price EVE itself values items at for industry
// fees — never a market price). A type CCP publishes no price for counts as
// unpriced rather than as zero, so the total is honest about what it covers.
export const totalEiv = (targets: readonly StockTarget[], prices: ReadonlyMap<number, number>): EivTotal =>
  reduce(
    (acc: EivTotal, t: StockTarget) => {
      const price = prices.get(t.typeId)
      return price === undefined
        ? { ...acc, unpriced: acc.unpriced + 1 }
        : { ...acc, eiv: acc.eiv + targetTotal(t) * price }
    },
    { eiv: 0, unpriced: 0 },
    targets
  )
