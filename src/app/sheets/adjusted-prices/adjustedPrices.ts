import { map } from 'ramda'

import { toCsv } from '../../../utils/csv.ts'

// The pure half of /sheets/adjusted-prices: CCP's adjusted prices as the CSV a
// sheet imports whole and looks types up in.

export type AdjustedPriceRow = {
  type_id: number
  adjusted_price: number
  average_price: number | null
  recorded_at: string
}

// Emitted alone when the table is empty, so the sheet sees an empty table
// rather than an empty body (which IMPORTDATA reports as an error). Must stay
// in step with the row shape below.
export const HEADER = 'TypeID,AdjustedPrice,AveragePrice,Updated'

// AveragePrice stays empty where CCP publishes none (~13% of types), never 0.
export const adjustedPriceCsv = (rows: AdjustedPriceRow[]): string =>
  toCsv(
    map(
      (row) => ({
        TypeID: row.type_id,
        AdjustedPrice: row.adjusted_price,
        AveragePrice: row.average_price,
        Updated: row.recorded_at,
      }),
      rows
    )
  ) || HEADER
