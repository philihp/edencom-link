// The /fitting ship matrix's pure shaping seam: hulls bucket into rows by
// class (Frigate → … → Capital) and columns by race (the four empires, plus
// Faction for everything outside their standard lines) — the layout every EVE
// ship chart uses, and how players actually think of their fits. No I/O (only
// ramda), so `pnpm test` can exercise it without a Supabase client.
import { ascend, groupBy, sortWith } from 'ramda'

import type { SdeType } from '@/sdeTypes'

// SDE race ids for the four empire ship lines. Everything else — pirate
// factions, ORE, SoCT (Jove), Triglavian, EDENCOM — lands in the Faction
// column, as does any empire hull the SDE stamps as meta-group Faction
// (navy/fleet issues, which carry an empire race_id but sit in the client's
// Faction tab).
export const RACE_COLUMNS = ['Amarr', 'Caldari', 'Gallente', 'Minmatar', 'Faction'] as const
export type RaceColumn = (typeof RACE_COLUMNS)[number]

const RACE_BY_ID: Record<number, RaceColumn> = {
  4: 'Amarr',
  1: 'Caldari',
  8: 'Gallente',
  2: 'Minmatar',
}

// SDE metaGroupIDs whose hulls the client files under Faction regardless of
// race: 3 Storyline, 4 Faction (navy + pirate).
const FACTION_META_GROUP_IDS = new Set([3, 4])

export const columnForType = (type: Pick<SdeType, 'raceID' | 'metaGroupID'> | undefined): RaceColumn => {
  if (type?.metaGroupID != null && FACTION_META_GROUP_IDS.has(type.metaGroupID)) return 'Faction'
  return (type?.raceID != null && RACE_BY_ID[type.raceID]) || 'Faction'
}

// Coarse hull classes, in the size order a ship chart reads in. The SDE splits
// each size into many groups (Frigate, Assault Frigate, Interceptor, …); the
// matrix folds them back into the size class players sort by. A group name
// missing from this mapping becomes its own row after the known classes (a new
// CCP hull line still renders rather than vanishing), sorted alphabetically.
export const CLASS_ROWS = [
  'Frigate',
  'Destroyer',
  'Cruiser',
  'Battlecruiser',
  'Battleship',
  'Capital',
  'Industrial',
] as const

const CLASS_BY_GROUP: Record<string, (typeof CLASS_ROWS)[number]> = {
  Frigate: 'Frigate',
  'Assault Frigate': 'Frigate',
  Interceptor: 'Frigate',
  'Covert Ops': 'Frigate',
  'Stealth Bomber': 'Frigate',
  'Electronic Attack Ship': 'Frigate',
  'Expedition Frigate': 'Frigate',
  'Logistics Frigate': 'Frigate',
  Destroyer: 'Destroyer',
  Interdictor: 'Destroyer',
  'Command Destroyer': 'Destroyer',
  'Tactical Destroyer': 'Destroyer',
  Cruiser: 'Cruiser',
  'Heavy Assault Cruiser': 'Cruiser',
  Logistics: 'Cruiser',
  'Force Recon Ship': 'Cruiser',
  'Combat Recon Ship': 'Cruiser',
  'Heavy Interdiction Cruiser': 'Cruiser',
  'Strategic Cruiser': 'Cruiser',
  'Flag Cruiser': 'Cruiser',
  'Combat Battlecruiser': 'Battlecruiser',
  'Attack Battlecruiser': 'Battlecruiser',
  'Command Ship': 'Battlecruiser',
  Battleship: 'Battleship',
  'Black Ops': 'Battleship',
  Marauder: 'Battleship',
  Dreadnought: 'Capital',
  'Lancer Dreadnought': 'Capital',
  Carrier: 'Capital',
  Supercarrier: 'Capital',
  Titan: 'Capital',
  'Force Auxiliary': 'Capital',
  // "Hauler" is CCP's current name for the old "Industrial" group; both are
  // mapped so the matrix survives either side of that rename in the SDE.
  Hauler: 'Industrial',
  Industrial: 'Industrial',
  'Deep Space Transport': 'Industrial',
  'Blockade Runner': 'Industrial',
  'Mining Barge': 'Industrial',
  Exhumer: 'Industrial',
  'Industrial Command Ship': 'Industrial',
  'Capital Industrial Ship': 'Industrial',
  Freighter: 'Industrial',
  'Jump Freighter': 'Industrial',
}

export const classForGroupName = (groupName: string | null | undefined): string =>
  (groupName && CLASS_BY_GROUP[groupName]) || groupName || 'Unknown'

// What the page feeds in: one fit from any source — a character's own saved
// fit or a corp/alliance fit published on the site — reduced to what placement
// needs (the hull) and what the cell renders (a link, a name, and a badge for
// the non-personal sources).
export type MatrixEntry = {
  href: string
  name: string
  shipTypeId: number
  badge?: string
}

// One fit placed in the matrix, with everything the cell renders.
export type MatrixFit = {
  href: string
  name: string
  hull: string
  badge?: string
}

export type MatrixRow = { shipClass: string; cells: Record<RaceColumn, MatrixFit[]> }

// Buckets every fit into (class row, race column), returning only the rows
// that hold at least one fit, known classes first in size order and unmapped
// group-name rows after them alphabetically. Cells sort by hull then fit name,
// so a cell holding several hulls reads grouped even without subheadings.
export const buildMatrix = (entries: MatrixEntry[], typeById: Record<number, SdeType>): MatrixRow[] => {
  const placed = entries.map((e) => {
    const type = typeById[e.shipTypeId]
    return {
      shipClass: classForGroupName(type?.groupName),
      column: columnForType(type),
      fit: {
        href: e.href,
        name: e.name,
        hull: type?.name ?? `#${e.shipTypeId}`,
        ...(e.badge ? { badge: e.badge } : {}),
      },
    }
  })

  const byClass = groupBy((p: (typeof placed)[number]) => p.shipClass, placed)
  const knownOrder = new Map<string, number>(CLASS_ROWS.map((c, i) => [c, i]))
  const classes = sortWith<string>(
    [ascend((c) => knownOrder.get(c) ?? CLASS_ROWS.length), ascend((c) => c)],
    Object.keys(byClass)
  )

  return classes.map((shipClass) => {
    const cells = Object.fromEntries(RACE_COLUMNS.map((col) => [col, [] as MatrixFit[]])) as Record<
      RaceColumn,
      MatrixFit[]
    >
    sortWith<(typeof placed)[number]>(
      [ascend((p) => p.fit.hull), ascend((p) => p.fit.name.toLowerCase())],
      byClass[shipClass] ?? []
    ).forEach((p) => cells[p.column].push(p.fit))
    return { shipClass, cells }
  })
}
