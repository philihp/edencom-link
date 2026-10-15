// The pure half of a corpse collection: one corpse as the page and its
// link-preview card show it, and what the card says about the lot. No I/O, so
// it is unit-tested (test/corpses.test.ts).
import { ascend, descend, sortWith } from 'ramda'

import { type StackIcon, MAX_STACKS } from '../asset/[locationId]/card/cardModel.ts'
import { metaColor } from '../ship/[itemId]/card/cardModel.ts'

// A corpse first seen within this window is flagged "New!".
export const NEW_WINDOW_MS = 48 * 60 * 60 * 1000

export type Corpse = {
  itemId: string
  typeId: number
  pilot: string | null
  isNew: boolean
}

// Strip the "'s Frozen Corpse" suffix ESI tacks onto a corpse's name, leaving
// just the dead pilot's name. Straight or curly apostrophe, case-insensitive.
export const pilotFromName = (name: string | null): string | null => {
  const trimmed = name?.trim()
  if (!trimmed) return null
  return trimmed.replace(/['’]s\s+Frozen\s+Corpse$/i, '').trim() || trimmed
}

// valid_from is this asset version's debut (the SCD-2 validity window's
// start) — for a corpse, effectively when it was first seen in the hangar.
// The pilot name lives in the asset name; a corpse whose name hasn't been
// resolved yet still counts, under its item id.
export const toCorpse = (
  row: { item_id: number | string; type_id: number | string; name: string | null; valid_from: string | null },
  now: number
): Corpse => {
  const firstSeenMs = row.valid_from ? new Date(row.valid_from).getTime() : NaN
  return {
    itemId: String(row.item_id),
    typeId: Number(row.type_id),
    pilot: pilotFromName(row.name),
    isNew: Number.isFinite(firstSeenMs) && firstSeenMs >= now - NEW_WINDOW_MS,
  }
}

// The card's icons: one per corpse type with how many, the most first.
export const corpseStacks = (corpses: readonly Corpse[]): StackIcon[] =>
  sortWith<[number, number]>([descend(([, count]) => count), ascend(([typeId]) => typeId)])([
    ...corpses.reduce((tally, c) => tally.set(c.typeId, (tally.get(c.typeId) ?? 0) + 1), new Map()).entries(),
  ])
    .slice(0, MAX_STACKS)
    .map(([typeId, count]) => ({ typeId, count, color: metaColor(null), variation: 'icon' as const }))

// "1 corpse", "12 corpses".
export const corpseCountText = (count: number): string => `${count} ${count === 1 ? 'corpse' : 'corpses'}`

// The line under the title in a chat embed.
export const corpsesDescription = (accountName: string | null, corpses: readonly Corpse[]): string => {
  const fresh = corpses.filter((c) => c.isNew).length
  return [
    accountName ? `The frozen corpses ${accountName} keeps.` : 'A collection of frozen corpses.',
    corpses.length === 0 ? 'None yet.' : `${corpseCountText(corpses.length)}.`,
    fresh > 0 ? `${fresh} new in the last two days.` : null,
  ]
    .filter((part) => part != null)
    .join(' ')
}
