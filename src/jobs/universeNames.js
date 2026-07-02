import {
  resolveAssetStationNames,
  resolveCorpJournalNames,
  resolveCorpStructureSystemNames,
  resolveKnownCorpNames,
} from '../resolveNames.js'
import { cli } from './lib.js'

const TAG = 'universe-names'

// POST /universe/names/ → universe_name. Resolves and caches a name for every
// id the other extracts have surfaced but that universe_name doesn't know yet:
// corp wallet journal parties, corporations seen in transactions/affiliations,
// NPC stations holding assets, and the solar systems our structures sit in.
// Cheap in steady state — each resolver only asks ESI for missing ids — so it
// can run often. Account-wide batch work, so it takes no character scope.
export const runUniverseNames = async () => {
  const resolvers = [
    ['corp journal parties', resolveCorpJournalNames],
    ['corporations', resolveKnownCorpNames],
    ['asset stations', resolveAssetStationNames],
    ['corp structure systems', resolveCorpStructureSystemNames],
  ]
  let failed = 0
  for (const [what, resolve] of resolvers) {
    try {
      await resolve()
    } catch (e) {
      failed += 1
      console.error(`[${TAG}] ${what} resolution FAILED message=${e?.message}`)
    }
  }
  if (failed === resolvers.length) throw new Error(`[${TAG}] every resolver failed`)
}

cli(import.meta.url, TAG, runUniverseNames)
