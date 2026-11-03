// The lingo a ship picks up from highsec (docs/ship-memory.md, "Extension:
// every singleton" → "Acquired accents" → "Ships in highsec"). Each highsec
// region belongs to an empire in the SDE, and a ship that dwells there
// borrows a few of that empire's phrases — never a change of accent, a
// seasoning on top of the hull's own voice. For each region the ship's docks
// fall in, the days are summed over its stops; regions of one empire add
// their days; the weight is min(LINGO_CAP, days / 365 × LINGO_CAP), small
// by design, and the tool reports it as `lingo` rather than an accent.
//
// Computed at recall from the itinerary, stored nowhere. The band is a
// parameter: the owner decided highsec only (securityStatus ≥ 0.45, the
// game's own rounding boundary for 0.5), and lowsec and nullsec regions carry
// factions too, so that can change in one place. Pure; no I/O.
import { sortBy } from 'ramda'

import { type Voice, voiceOf } from './accent.ts'
import type { Place, Stop } from './dossier.ts'

// A year of dwell earns the cap and no more.
export const LINGO_CAP = 0.1
export const LINGO_FULL_DAYS = 365
// EVE rounds a system's security to one decimal for display, so 0.45 is the
// lowest true security a system shown as 0.5 can have.
export const HIGHSEC_MIN_SECURITY = 0.45

export type SystemInfo = { security: number; regionId: number | null }

export type LingoOptions = { cap?: number; minSecurity?: number }

export type Lingo = Voice & {
  factionId: number
  regionIds: number[]
  // Days docked in the band's regions of this empire, before the cap.
  days: number
  // min(cap, days / 365 × cap)
  weight: number
}

export const lingoWeight = (days: number, cap = LINGO_CAP): number =>
  Math.min(cap, (Math.max(0, days) / LINGO_FULL_DAYS) * cap)

// Dwell per region over the stops that resolve to a system in the band.
export const regionDwell = (
  stops: Stop[],
  systemOf: (place: Place) => number | null,
  systemInfo: (systemId: number) => SystemInfo | null,
  minSecurity = HIGHSEC_MIN_SECURITY
): Map<number, number> =>
  stops.reduce<Map<number, number>>((acc, stop) => {
    if (stop.place == null) return acc
    const systemId = systemOf(stop.place)
    const info = systemId == null ? null : systemInfo(systemId)
    if (info == null || info.regionId == null || info.security < minSecurity) return acc
    acc.set(info.regionId, (acc.get(info.regionId) ?? 0) + stop.hours / 24)
    return acc
  }, new Map())

// The empires whose lingo the ship has picked up, heaviest first. A region
// the SDE gives no faction teaches nothing.
export const lingo = (
  stops: Stop[],
  systemOf: (place: Place) => number | null,
  systemInfo: (systemId: number) => SystemInfo | null,
  factionOfRegion: (regionId: number) => number | null,
  options: LingoOptions = {}
): Lingo[] => {
  const cap = options.cap ?? LINGO_CAP
  const dwell = regionDwell(stops, systemOf, systemInfo, options.minSecurity ?? HIGHSEC_MIN_SECURITY)
  const byFaction = [...dwell.entries()].reduce<Map<number, Lingo>>((acc, [regionId, days]) => {
    const factionId = factionOfRegion(regionId)
    if (factionId == null) return acc
    const entry = acc.get(factionId) ?? {
      ...voiceOf({ factionId, raceId: null }),
      factionId,
      regionIds: [],
      days: 0,
      weight: 0,
    }
    entry.days += days
    entry.regionIds.push(regionId)
    acc.set(factionId, entry)
    return acc
  }, new Map())
  return sortBy(
    (l) => -l.weight,
    [...byFaction.values()].map((l) => ({
      ...l,
      days: Math.round(l.days * 10) / 10,
      weight: Math.round(lingoWeight(l.days, cap) * 1000) / 1000,
    }))
  )
}
