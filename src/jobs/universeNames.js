import {
  resolveAssetStationNames,
  resolveAssetSystemNames,
  resolveCorpJournalNames,
  resolveCorpStructureSystemNames,
  resolveKnownCorpNames,
} from '../resolveNames.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'universe-names'

// POST /universe/names/ → universe_name. Resolves and caches a name for every
// id the other extracts have surfaced but that universe_name doesn't know yet:
// corp wallet journal parties, corporations seen in transactions/affiliations,
// NPC stations holding assets, the solar systems our structures sit in, and the
// solar systems any asset is floating in directly. Cheap in steady state — each
// resolver only asks ESI for missing ids — so it can run often. Account-wide
// batch work, so it takes no character scope.
export const runUniverseNames = async () => {
  const resolvers = [
    ['corp journal parties', resolveCorpJournalNames],
    ['corporations', resolveKnownCorpNames],
    ['asset stations', resolveAssetStationNames],
    ['corp structure systems', resolveCorpStructureSystemNames],
    ['asset systems', resolveAssetSystemNames],
  ]
  let failed = 0
  await forEachSequential(resolvers, async ([what, resolve]) => {
    try {
      await resolve()
    } catch (e) {
      failed += 1
      console.error(`[${TAG}] ${what} resolution FAILED message=${e?.message}`)
    }
  })
  if (failed === resolvers.length) throw new Error(`[${TAG}] every resolver failed`)
}

cli(import.meta.url, TAG, runUniverseNames)
