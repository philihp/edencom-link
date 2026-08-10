// Flatten a Lens result to CSV-ready rows (docs/sharing-layer/07-lens.md).
// The validator guarantees exactly one top-level field, so the "primary list"
// is unambiguous: the root value itself when it's a list (marketOrders,
// walletBalances, …), its `rows` list when it's a page object (assets,
// blueprints), or the object itself as a single row otherwise. Each row is
// flattened to one level: scalars kept, nested objects dot-pathed, lists of
// scalars joined — anything deeper is left for toCsv's JSON fallback.
//
// Shared with the /graphql editor's "Download CSV" — the same flattening, since
// a lens IS a stored GraphQL query. The schema's entity edges (owner, type,
// location) are leaf-only by construction, so one level is always enough; see
// the SDL header in src/app/api/graphql/schema.graphql.ts.
//
// Pure module (ramda only) so `node --test` covers it: test/lensFlatten.test.ts.
import { chain, toPairs, uniq } from 'ramda'

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

// lensRows, then squared off so every row carries the SAME columns in the same
// order — what toCsv needs, since it takes its header from the first row alone
// and drops whatever isn't there. Two things make the rows ragged, both from
// nullable entity edges:
//
//   - a null edge flattens to nothing, so `location { name }` yields
//     `location.name` on the rows that have one and no such key on the rest;
//   - the null rows keep a bare `location` key instead, which has to give way —
//     a GraphQL field has one type, so a key that expands anywhere is an edge
//     everywhere, and the bare key is always the null case.
//
// Missing cells become null, which toCsv writes as empty.
export const csvRows = (data: unknown): Row[] => {
  const rows = primaryRows(data)
  const expanded = new Set(
    chain(
      (row: Row) =>
        toPairs(row)
          .filter(([, value]) => isPlainObject(value))
          .map(([key]) => key),
      rows
    )
  )
  const flat = rows.map(flattenRow)
  const columns = uniq(chain(Object.keys, flat)).filter((column) => !expanded.has(column))
  return flat.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])))
}
