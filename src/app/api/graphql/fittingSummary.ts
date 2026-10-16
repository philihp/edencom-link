// A fit's module list as one flat cell, for the GraphQL Fitting and
// MarshalledFitting rows (docs/fitting-marshal.md PR 5). Rows have to flatten
// to one CSV line (see the entity-edge invariant in test/graphqlSchema.test.ts),
// so the items — the one list a fit carries — are summarised the way a
// contract's are by summariseItems: "2 x Damage Control II, 1 x …", in the
// fitting window's slot order, same-type stacks summed. Pure, no I/O.
import { flagSortKey, type FittingItem } from '../../fitting/fit.ts'

export type ModuleLine = { typeId: number; name: string; quantity: number; sortKey: number }

/**
 * One line per distinct type, quantities summed, ordered by the slot family of
 * the first flag the type appears in (high → mid → low → rigs → …) and then by
 * name, so two readers of the same fit see the same cell.
 */
export const moduleLines = (
  items: ReadonlyArray<FittingItem> | null | undefined,
  nameOf: (typeId: number) => string | null | undefined
): ModuleLine[] => {
  const byType = new Map<number, ModuleLine>()
  ;(items ?? []).forEach((item) => {
    const typeId = Number(item.type_id)
    const quantity = Number(item.quantity ?? 1)
    const sortKey = flagSortKey(item.flag ?? '')
    const existing = byType.get(typeId)
    if (existing) {
      existing.quantity += quantity
      existing.sortKey = Math.min(existing.sortKey, sortKey)
    } else {
      byType.set(typeId, { typeId, name: nameOf(typeId) ?? `Type #${typeId}`, quantity, sortKey })
    }
  })
  return [...byType.values()].sort((a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name))
}

/** The cell itself; null for an empty fit, so a CSV column reads as missing. */
export const moduleSummary = (
  items: ReadonlyArray<FittingItem> | null | undefined,
  nameOf: (typeId: number) => string | null | undefined
): string | null => {
  const lines = moduleLines(items, nameOf)
  return lines.length === 0 ? null : lines.map((l) => `${l.quantity} x ${l.name}`).join(', ')
}

/** How many modules, charges and drones the fit carries, stacks counted whole. */
export const itemCount = (items: ReadonlyArray<FittingItem> | null | undefined): number =>
  (items ?? []).reduce((n, item) => n + Number(item.quantity ?? 1), 0)
