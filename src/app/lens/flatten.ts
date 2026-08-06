// Flatten a Lens result to CSV-ready rows (docs/sharing-layer/07-lens.md).
// The validator guarantees exactly one top-level field, so the "primary list"
// is unambiguous: the root value itself when it's a list (marketOrders,
// walletBalances, …), its `rows` list when it's a page object (assets,
// blueprints), or the object itself as a single row otherwise. Each row is
// flattened to one level: scalars kept, nested objects dot-pathed, lists of
// scalars joined — anything deeper is left for toCsv's JSON fallback.
//
// Pure module (ramda only) so `node --test` covers it: test/lensFlatten.test.ts.
import { chain, toPairs } from 'ramda'

type Row = Record<string, unknown>

const isPlainObject = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

// The rows behind the single root field's value.
export const primaryRows = (data: unknown): Row[] => {
  if (data == null) return []
  const values = isPlainObject(data) ? Object.values(data) : []
  if (values.length !== 1) return []
  const [value] = values
  if (Array.isArray(value)) return value.filter(isPlainObject)
  if (isPlainObject(value)) {
    if (Array.isArray(value.rows)) return (value.rows as unknown[]).filter(isPlainObject)
    return [value]
  }
  return []
}

const flattenEntry = ([key, value]: [string, unknown]): Array<[string, unknown]> => {
  if (isPlainObject(value)) {
    return toPairs(value).map(([nested, nestedValue]): [string, unknown] => [`${key}.${nested}`, nestedValue])
  }
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) {
    return [[key, value.map((v) => (v == null ? '' : String(v))).join(', ')]]
  }
  return [[key, value]]
}

export const flattenRow = (row: Row): Row => Object.fromEntries(chain(flattenEntry, toPairs(row)))

export const lensRows = (data: unknown): Row[] => primaryRows(data).map(flattenRow)
