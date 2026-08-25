// The pure half of the shared-library blueprint search: which of the SDE's
// name matches are blueprints worth querying for, and how the rows that come
// back collapse into the lines a visitor reads. No I/O, so the rules are
// testable on their own.
import { reduce, sort } from 'ramda'

import { BLUEPRINT_CATEGORY_ID } from '../../utils/sdeCategories.ts'

import { isOriginal, rowQuantity, type BlueprintRow } from '../bpos/stack.ts'

// The shape src/sdeTypes.ts's search returns, restated structurally so this
// module pulls in no database client.
export type TypeMatch = { typeID: number; name: string; categoryID: number | null }

// A substring search over type names matches the product as readily as the
// blueprint ("Rifter" finds both), and only the blueprint can be in a library.
// The names ride along so the hits below can be labelled without a second
// lookup.
export const blueprintMatches = (results: readonly TypeMatch[]): Map<number, string> =>
  reduce(
    (acc: Map<number, string>, r: TypeMatch) =>
      r.categoryID === BLUEPRINT_CATEGORY_ID ? acc.set(r.typeID, r.name) : acc,
    new Map<number, string>(),
    results
  )

// One line of a library's answer: a blueprint it holds, and how many.
export type BlueprintHit = { typeId: number; name: string; quantity: number }

// Rows from one library, collapsed per type. Unlike the showcase's stacking
// this does NOT split on ME/TE — the question here is only whether a library
// has the thing at all, so eight copies at four research levels read as "×8".
// Copies are dropped (the showcase's own rule, re-checked here so a caller
// that forgets the SQL filter still can't leak one), as is any type the name
// map doesn't cover — a library row for something the search didn't ask about
// has no business in the answer.
export const foldHits = (rows: readonly BlueprintRow[], names: ReadonlyMap<number, string>): BlueprintHit[] => {
  const byType = reduce(
    (acc: Map<number, BlueprintHit>, row: BlueprintRow) => {
      if (!isOriginal(row)) return acc
      const typeId = Number(row.type_id)
      const name = names.get(typeId)
      if (name === undefined) return acc
      const seen = acc.get(typeId)
      if (seen) seen.quantity += rowQuantity(row)
      else acc.set(typeId, { typeId, name, quantity: rowQuantity(row) })
      return acc
    },
    new Map<number, BlueprintHit>(),
    rows
  )
  return sort(
    (a: BlueprintHit, b: BlueprintHit) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.typeId - b.typeId,
    [...byType.values()]
  )
}

// A one- or two-letter substring matches thousands of types and would fan out
// into a query per chunk per library for an answer nobody could read. Three is
// the shortest term that means anything ("orc", "web").
export const MIN_QUERY_LENGTH = 3

// One shared library's answer: where it is, who to ask, and what it holds.
export type SharedSearchHit = {
  key: string
  href: string
  label: string
  kind: 'corporation' | 'account'
  // Who published it: for a corporation, the member who did; for an account,
  // the owner themselves.
  sharedBy: string | null
  hits: BlueprintHit[]
}

export type SharedSearchResult = {
  // Echoed back so a stale response can be recognised by the caller.
  query: string
  // No shared libraries at all — a different answer from "nobody has one".
  libraries: number
  results: SharedSearchHit[]
}
