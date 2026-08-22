// The pure half of the BPO showcase: which blueprint rows are originals, how
// identical ones stack, and the two orders the table offers. No I/O, so the
// rules that decide what a visitor sees are testable on their own.
import { reduce } from 'ramda'

// The subset of character_blueprint the showcase reads. Bigints arrive from
// PostgREST as strings, so every id is widened to `number | string` and
// normalized here.
export type BlueprintRow = {
  type_id: number | string
  material_efficiency: number | string | null
  time_efficiency: number | string | null
  quantity: number | string | null
  runs: number | string | null
}

// ESI marks an original with runs = -1; a copy carries the runs it has left.
// That single field is the whole test — `quantity` distinguishes a researched
// singleton (-1) from an unresearched stack (a positive count), never original
// from copy.
export const isOriginal = (row: BlueprintRow): boolean => Number(row.runs) === -1

// How many blueprints one row represents: ESI reports a stack of identical
// unresearched originals as a positive quantity, and anything singleton (a
// researched original, which can't stack) as -1.
export const rowQuantity = (row: BlueprintRow): number => {
  const q = Number(row.quantity)
  return Number.isFinite(q) && q > 0 ? q : 1
}

export type BpoStack = {
  typeId: number
  materialEfficiency: number
  timeEfficiency: number
  quantity: number
}

// Identical (type, ME, TE) blueprints collapse into one line with a count —
// the showcase is about what someone HAS, and eight unresearched Rifter BPOs
// are one entry worth "×8", not eight rows. Non-originals are dropped here as
// well as in SQL, so a caller that forgets the filter still can't leak a copy.
export const stackBpos = (rows: readonly BlueprintRow[]): BpoStack[] => [
  ...reduce(
    (acc, row) => {
      if (!isOriginal(row)) return acc
      const stack: BpoStack = {
        typeId: Number(row.type_id),
        materialEfficiency: Number(row.material_efficiency ?? 0),
        timeEfficiency: Number(row.time_efficiency ?? 0),
        quantity: rowQuantity(row),
      }
      const key = `${stack.typeId}|${stack.materialEfficiency}|${stack.timeEfficiency}`
      const seen = acc.get(key)
      if (seen) seen.quantity += stack.quantity
      else acc.set(key, stack)
      return acc
    },
    new Map<string, BpoStack>(),
    rows
  ).values(),
]

// A stack with its SDE names resolved — what the table actually renders.
// `category` is the PRODUCT's category ("Ship", "Module", "Charge"), not the
// blueprint's own: every blueprint type sits in category "Blueprint", which
// would sort the whole page into one bucket.
export type BpoEntry = BpoStack & { name: string | null; category: string | null }

export type SortKey = 'name' | 'category'

export const SORT_KEYS: SortKey[] = ['name', 'category']

export const isSortKey = (value: string | null | undefined): value is SortKey =>
  value === 'name' || value === 'category'

const byName = (a: BpoEntry, b: BpoEntry): number =>
  (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }) ||
  b.materialEfficiency - a.materialEfficiency ||
  b.timeEfficiency - a.timeEfficiency ||
  a.typeId - b.typeId

// Unresolved categories sort last rather than under the empty string, so a
// type the SDE mirror hasn't caught up with doesn't head the list.
const byCategory = (a: BpoEntry, b: BpoEntry): number =>
  Number(a.category == null) - Number(b.category == null) ||
  (a.category ?? '').localeCompare(b.category ?? '', undefined, { sensitivity: 'base' }) ||
  byName(a, b)

export const sortBpos = (entries: readonly BpoEntry[], key: SortKey): BpoEntry[] =>
  [...entries].sort(key === 'category' ? byCategory : byName)

// The tally under the title counts blueprints, not lines: a stack of eight
// counts eight.
export const totalBpos = (entries: readonly { quantity: number }[]): number =>
  entries.reduce((sum, e) => sum + e.quantity, 0)
