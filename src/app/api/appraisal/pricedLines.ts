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
