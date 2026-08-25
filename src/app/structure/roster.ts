// Which structures /structure lists, and which of its three blocks each one
// lands in.
//
// The page used to list exactly `corp_structure` — the structures a director
// token can scan. That is the set we OWN (widened to alliance-mates by a second
// RLS policy), not the set we USE: a job installed in somebody else's Sotiyo
// leaves a facility id in our own industry-job rows and nothing else, so a
// structure our slots actually run in never appeared here at all. It showed up
// only as ISK under "taxes paid elsewhere", with no tile to belong to.
//
// So the roster is the union of two sources:
//
//   - `corp_structure` — the rich data (state, services, fuel timers, rigs).
//     Needs a director in the owning corporation.
//   - every player-structure id appearing as a job location in our own
//     industry-job tables, named from the `universe_structure` directory. No
//     director means no fitting and no capabilities; what remains is what ESI
//     hands any visitor — a name, a system, a type and an owner.
//
// Both are already in Postgres, so discovering the second set costs no ESI call
// (the same trick `universe-structures` plays to build its candidate list).
import { filter, forEach, map, uniq } from 'ramda'

// Player Upwell structures use ids at or above this; NPC stations (≤64M) sit
// far below it. A job location under the floor is a station, which is nobody's
// structure and gets no tile. Same constant, same reasoning, as
// src/jobs/universeStructures.js.
export const STRUCTURE_ID_FLOOR = 100_000_000_000

export const isPlayerStructureId = (id: number | string | null | undefined): boolean => {
  if (id == null) return false
  const n = Number(id)
  return Number.isFinite(n) && n >= STRUCTURE_ID_FLOOR
}

// A job knows where it ran as `station_id`, falling back to `facility_id` —
// the same precedence the tax attribution uses, so a job resolves to one
// structure here and the same one there.
export type JobLocation = {
  station_id?: number | string | null
  facility_id?: number | string | null
}

export const jobLocationId = (job: JobLocation): string | null => {
  const id = job.station_id ?? job.facility_id
  return isPlayerStructureId(id) ? String(id) : null
}

// Every player structure our jobs have run in, as strings (PostgREST hands
// bigints back as strings often enough that keying on anything else silently
// splits a structure in two).
export const jobStructureIds = (jobs: readonly JobLocation[]): string[] =>
  uniq(filter((id): id is string => id != null, map(jobLocationId, jobs)))

// The three blocks, in render order.
export type Tier = 'favorite' | 'ours' | 'others'

export type Tierable = {
  structureId: string
  // Null when the directory has never resolved the structure — we know a job of
  // ours ran there and nothing else.
  ownerCorporationId: string | null
  // True for a row that came from `corp_structure`: a corporation we hold a
  // director in, or an alliance-mate's. Whether we can scan it is the whole
  // distinction the user asked for, so it is the primary test for "ours".
  scanned: boolean
}

export type TierInput = {
  // Pinned structure ids -> their drag order.
  favoritePosition: ReadonlyMap<string, number>
  // Corporations one of our characters belongs to.
  ownCorporationIds: ReadonlySet<string>
}

// A pin wins outright: the star's job is to lift a tile out of whichever block
// it would otherwise sit in.
//
// Otherwise "ours" is anything we scan, plus anything owned by a corporation
// we're in. That second clause is not redundant: a structure owned by our own
// corporation is absent from `corp_structure` whenever no linked character
// holds the Station_Manager role there, which is exactly the gap this roster
// exists to fill — it would be perverse to file our own Athanor under everyone
// else's.
export const structureTier = (s: Tierable, { favoritePosition, ownCorporationIds }: TierInput): Tier => {
  if (favoritePosition.has(s.structureId)) return 'favorite'
  if (s.scanned) return 'ours'
  if (s.ownerCorporationId != null && ownCorporationIds.has(s.ownerCorporationId)) return 'ours'
  return 'others'
}

export type Tiers<T> = { favorites: T[]; ours: T[]; others: T[] }

// Split into the three blocks, preserving the caller's order within `ours` and
// `others` (the selects already order those) and imposing the pin order on
// `favorites`.
export const groupByTier = <T extends Tierable>(list: readonly T[], input: TierInput): Tiers<T> => {
  // Push-mutated per block rather than three filtering passes: one walk, and
  // the accumulator never gets re-spread (the house exception for a fold that
  // builds arrays).
  const tiers: Tiers<T> = { favorites: [], ours: [], others: [] }
  forEach((s: T) => {
    const tier = structureTier(s, input)
    if (tier === 'favorite') tiers.favorites.push(s)
    else if (tier === 'ours') tiers.ours.push(s)
    else tiers.others.push(s)
  }, list)
  tiers.favorites.sort(
    (a, b) => (input.favoritePosition.get(a.structureId) ?? 0) - (input.favoritePosition.get(b.structureId) ?? 0)
  )
  return tiers
}
