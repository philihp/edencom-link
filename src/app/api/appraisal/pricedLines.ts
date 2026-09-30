// Appraisal results as per-line unit prices, and the one place hull_price is
// applied to them. Pure (no I/O), so it is unit-tested
// (test/pricedLines.test.ts). Shared by the Appraise button's route and the
// ship link-preview card, so the two cannot price a ship differently.

// One priced line: an item name, how many, and the unit prices. Null means the
// provider could not price it.
export type PricedLine = { name: string; quantity: number; sell: number | null; buy: number | null }

export type PricedTotals = {
  sell: number
  buy: number
  // Names of lines that had no price and are left out of both totals.
  unpriced: string[]
}

// Structural, so this module does not import src/innominate.ts (which reaches
// for the queue and a Supabase client).
type AppraisedItem = { sellPrice: number | null; buyPrice: number | null; error: string | null }

// The provider answers item by item in request order, so line i of the
// request is item i of the answer. Name and quantity come from the request:
// the provider's own copy of them is empty on a line it could not match.
export const fromAppraisal = (lines: { name: string; quantity: number }[], items: AppraisedItem[]): PricedLine[] =>
  lines.map((line, i) => {
    const item = items[i]
    const priced = item != null && item.error == null
    return {
      name: line.name,
      quantity: line.quantity,
      sell: priced ? item.sellPrice : null,
      buy: priced ? item.buyPrice : null,
    }
  })

// A hull with a set price takes it as both its sell and its buy price, in
// place of whatever the market said (nothing, for a supercarrier or a titan).
export const applyHullPrices = (lines: PricedLine[], hullPrices: Map<string, number>): PricedLine[] =>
  lines.map((line) => {
    const price = hullPrices.get(line.name)
    return price == null ? line : { ...line, sell: price, buy: price }
  })

export const pricedTotals = (lines: PricedLine[]): PricedTotals =>
  lines.reduce<PricedTotals>(
    (totals, line) =>
      line.sell == null
        ? { ...totals, unpriced: [...totals.unpriced, line.name] }
        : {
            sell: totals.sell + line.quantity * line.sell,
            buy: totals.buy + line.quantity * (line.buy ?? 0),
            unpriced: totals.unpriced,
          },
    { sell: 0, buy: 0, unpriced: [] }
  )

// The provider's per-item answer, as the MCP appraisal tools hand it on. Only
// the fields hull pricing reads or rewrites; the tools keep the rest.
export type AppraisedRow = {
  name: string
  quantity: number
  sellPrice: number | null
  buyPrice: number | null
  totalSellPrice: number | null
  totalBuyPrice: number | null
  error: string | null
}

export type HullPricedAppraisal<T extends AppraisedRow> = {
  items: T[]
  totalSellValue: number
  totalBuyValue: number
  // (sell + buy) / 2 over the batch, the provider's own definition.
  priceSplit: number
  // The lines a set hull price replaced, by name. Empty when none did, in
  // which case the provider's items and totals come back untouched.
  hullPriced: string[]
}

// applyHullPrices for a whole provider answer: a hull with a set price takes
// it as sell and buy (a line the provider could not price is priced now, so
// its error clears), and the batch totals are summed again from the lines,
// since the provider's totals were built without the hull.
export const hullPricedAppraisal = <T extends AppraisedRow>(
  items: T[],
  hullPrices: Map<string, number>,
  provided: { totalSellValue: number; totalBuyValue: number; priceSplit: number }
): HullPricedAppraisal<T> => {
  const hullPriced = items.filter((item) => hullPrices.has(item.name)).map((item) => item.name)
  if (hullPriced.length === 0) return { items, ...provided, hullPriced }
  const priced = items.map((item) => {
    const price = hullPrices.get(item.name)
    return price == null
      ? item
      : {
          ...item,
          sellPrice: price,
          buyPrice: price,
          totalSellPrice: item.quantity * price,
          totalBuyPrice: item.quantity * price,
          error: null,
        }
  })
  const totalSellValue = priced.reduce((sum, item) => sum + (item.error == null ? (item.totalSellPrice ?? 0) : 0), 0)
  const totalBuyValue = priced.reduce((sum, item) => sum + (item.error == null ? (item.totalBuyPrice ?? 0) : 0), 0)
  return { items: priced, totalSellValue, totalBuyValue, priceSplit: (totalSellValue + totalBuyValue) / 2, hullPriced }
}
