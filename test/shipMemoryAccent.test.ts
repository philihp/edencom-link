// Unit coverage for the voice a ship's memory is written in
// (src/app/ship/memory/accent.ts, docs/ship-memory.md "Accent"). The chart is
// the owner's to edit in the doc, so the doc is read here and every row pinned
// against the module: an edit to one without the other fails. The hulls below
// carry their real SDE factionID/raceID, read from the mirror on 2026-11-01.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { FACTION_ACCENTS, NEUTRAL, RACE_ACCENTS, voiceOf } from '../src/app/ship/memory/accent.ts'
import type { Accent } from '../src/app/ship/memory/accent.ts'

const DOC_PATH = 'docs/ship-memory.md'

// The rows of the doc's accent chart: the table whose header starts
// "| Faction / race", up to the first line that is not a table row.
const docChart = (): Accent[] => {
  const lines = readFileSync(join(process.cwd(), DOC_PATH), 'utf-8').split('\n')
  const header = lines.findIndex((line) => line.startsWith('| Faction / race'))
  assert.ok(header >= 0, `no accent chart in ${DOC_PATH}`)
  const rows = lines.slice(header + 2)
  const end = rows.findIndex((line) => !line.startsWith('|'))
  return rows.slice(0, end === -1 ? undefined : end).map((line) => {
    const [label, accent, notes] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    return { label: label === '_neutral_' ? NEUTRAL.label : label, accent, notes }
  })
}

const moduleChart = (): Accent[] => [...new Set([...FACTION_ACCENTS.values(), ...RACE_ACCENTS.values(), NEUTRAL])]

const byLabel = (a: Accent, b: Accent) => a.label.localeCompare(b.label)

test('every row of the doc’s chart is in the module, word for word, and nothing else is', () => {
  const doc = docChart()
  assert.ok(doc.length > 20, `expected the whole chart, read ${doc.length} rows`)
  assert.deepEqual([...moduleChart()].sort(byLabel), [...doc].sort(byLabel))
})

test('the faction comes before the race', () => {
  // Gila: Guristas Pirates by faction, Caldari by race.
  const gila = voiceOf({ factionId: 500010, raceId: 1 })
  assert.equal(gila.label, 'Guristas Pirates')
  assert.equal(gila.from, 'faction')
  // Gnosis: The Society of Conscious Thought by faction, Jove by race.
  assert.equal(voiceOf({ factionId: 500017, raceId: 16 }).label, 'The Society of Conscious Thought')
  // Astero: Servant Sisters of EVE by faction, Gallente by race.
  assert.equal(voiceOf({ factionId: 500016, raceId: 8 }).label, 'Servant Sisters of EVE')
})

test('an empire hull speaks for its empire, navy issue included', () => {
  assert.equal(voiceOf({ factionId: 500002, raceId: 2 }).label, 'Minmatar Republic') // Rifter
  assert.equal(voiceOf({ factionId: 500001, raceId: 1 }).label, 'Caldari State') // Raven Navy Issue
  assert.equal(voiceOf({ factionId: 500026, raceId: 135 }).label, 'Triglavian Collective') // Leshak
  assert.equal(voiceOf({ factionId: 500014, raceId: 128 }).label, 'ORE') // Rorqual
})

test('Mordu’s Legion hulls get the drill sergeant', () => {
  // Garmur, Orthrus and Barghest all carry Mordu's Legion Command.
  assert.equal(voiceOf({ factionId: 500018, raceId: 1 }).accent, 'Texas drill sergeant')
})

test('a faction the chart has no row for falls through to the race', () => {
  const syndicate = voiceOf({ factionId: 500009, raceId: 8 })
  assert.equal(syndicate.label, 'Gallente Federation')
  assert.equal(syndicate.from, 'race')
  assert.equal(voiceOf({ factionId: null, raceId: 64 }).label, 'Drifters / Sleepers')
})

test('a hull the SDE does not place is neutral', () => {
  assert.equal(voiceOf({ factionId: 500025, raceId: 134 }).from, 'neutral') // Rogue Drones, both ways
  assert.equal(voiceOf({ factionId: null, raceId: 168 }).from, 'neutral') // Upwell
  assert.equal(voiceOf({ factionId: null, raceId: null }).accent, NEUTRAL.accent)
})
