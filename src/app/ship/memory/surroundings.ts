// What stands around a ship's home when its own record is thin
// (docs/ship-memory.md, "The first version" → "Surroundings"): the system it
// first appeared in — or, with no place on record there, the one it has
// dwelt in longest — the NPC stations in that system with the corporations
// that run them and the named people the SDE puts there, and the temperate
// planets in that system and one jump out, where a crew might be from. A
// first memory can be rooted in these without inventing anything: every
// name exists in the game, so a later visit to that planet or station lands.
// Pure; the loader is the tool (memoryTools.ts) over src/sdeNpc.ts,
// src/sdePlanets.ts and src/sdeJumps.ts.
import { sortBy } from 'ramda'

import type { Place, Stop } from './dossier.ts'

// The system a first memory is rooted in: the debut's, when the debut had a
// place that resolves to one; else the system of the stop with the most
// hours; else null (a hull only ever seen inside another item).
export const homeSystemOf = (
  debutPlace: Place | null,
  stops: Stop[],
  systemOf: (place: Place) => number | null
): number | null => {
  const atDebut = debutPlace == null ? null : systemOf(debutPlace)
  if (atDebut != null) return atDebut
  const byDwell = stops.reduce<Map<number, number>>((acc, s) => {
    const id = s.place == null ? null : systemOf(s.place)
    if (id != null) acc.set(id, (acc.get(id) ?? 0) + s.hours)
    return acc
  }, new Map())
  const most = sortBy(([, hours]) => -hours, [...byDwell.entries()])[0]
  return most?.[0] ?? null
}

export type SurroundingStation = {
  stationID: number
  name: string
  corporation: string | null
  // The corporation's SDE blurb, first sentence.
  about: string | null
  // Named NPC characters the SDE places at this station, CEOs first.
  people: Array<{ name: string; role: 'ceo' | 'agent' | 'staff' }>
}

export type SurroundingPlanet = { name: string; systemName: string | null; jumps: 0 | 1 }

export const MAX_STATIONS = 8
export const MAX_PEOPLE_PER_STATION = 3
export const MAX_PLANETS = 6

// The first sentence of a blurb, so the companion gets the corporation's
// character rather than its whole history.
export const firstSentence = (text: string | null): string | null => {
  if (text == null) return null
  const trimmed = text.trim()
  if (trimmed === '') return null
  const match = /^.*?[.!?](?=\s|$)/.exec(trimmed)
  return match ? match[0] : trimmed
}

export type SurroundingsInput = {
  stations: Array<{ stationID: number; name: string; ownerCorporationID: number | null }>
  corporations: Record<number, { name: string; description: string | null }>
  people: Array<{ name: string; stationID: number | null; ceo: boolean; agent: boolean }>
  // Temperate planets with how many jumps out they sit: 0 in the home system.
  planets: Array<{ name: string; systemName: string | null; jumps: 0 | 1 }>
}

export type Surroundings = { stations: SurroundingStation[]; temperate_planets: SurroundingPlanet[] }

// Trimmed to what a memory can use: a few stations (those with named people
// first), a few people per station (CEOs, then agents), and the nearest
// temperate planets (in-system first).
export const pickSurroundings = (input: SurroundingsInput): Surroundings => {
  const peopleAt = (stationID: number) =>
    sortBy(
      (p) => (p.role === 'ceo' ? 0 : p.role === 'agent' ? 1 : 2),
      input.people
        .filter((p) => p.stationID === stationID)
        .map((p) => ({
          name: p.name,
          role: p.ceo ? ('ceo' as const) : p.agent ? ('agent' as const) : ('staff' as const),
        }))
    ).slice(0, MAX_PEOPLE_PER_STATION)
  const stations = sortBy(
    (s) => (s.people.length > 0 ? 0 : 1),
    input.stations.map((s) => {
      const corp = s.ownerCorporationID == null ? undefined : input.corporations[s.ownerCorporationID]
      return {
        stationID: s.stationID,
        name: s.name,
        corporation: corp?.name ?? null,
        about: firstSentence(corp?.description ?? null),
        people: peopleAt(s.stationID),
      }
    })
  ).slice(0, MAX_STATIONS)
  const temperate_planets = sortBy((p) => p.jumps, input.planets).slice(0, MAX_PLANETS)
  return { stations, temperate_planets }
}
