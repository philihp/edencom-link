// CSV for the lab copy, in the form `psql \copy … csv header` reads back
// without loss. src/utils/csv.ts writes for Google Sheets and gives null and
// '' the same empty cell; COPY would read both as null. Here a string is
// always quoted, so '' stays '' and only a bare empty cell is null.
import { join, map } from 'ramda'

const quote = (text: string): string => `"${text.replace(/"/g, '""')}"`

export const csvCell = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return quote(value)
  if (typeof value === 'object') return quote(JSON.stringify(value))
  return String(value)
}

export const csvLine: (values: readonly unknown[]) => string = (values) => join(',', map(csvCell, values))

// The rows of one page as CSV lines in `columns` order, each with its newline.
export const csvRows = (columns: readonly string[], rows: readonly Record<string, unknown>[]): string =>
  join(
    '',
    map((row) => `${csvLine(map((column) => row[column], columns))}\n`, rows)
  )
