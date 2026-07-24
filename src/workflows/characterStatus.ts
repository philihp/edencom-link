// character-status as a Vercel Workflow — phase 3, PR 4 of the cron → Workflows
// migration (docs/cron-to-workflows/03-per-character.md). The combined live-state
// job: five cheap per-character pulls (wallet, location, implants, clones, ship)
// folded into one extract, internally fault-isolated per endpoint.
//
// Same fan-out shape as the three per-character jobs already migrated, with one
// wrinkle: character-status fronts five endpoints with *different* scopes, so it
// enumerates every character carrying *any* of them. enumerateCharacters passes
// the scopes straight to selectCharacterIdsWithScopes, which unions them (array
// overlap) — exactly what fanOutPerCharacterAnyScopeCronJob did. The job's
// handler (forEachCharacterAnyScope) still runs only the endpoints each token is
// authorized for.
//
// Formerly the cron route fanned out one Vercel queue message per such character;
// it now start()s this workflow, which enumerates them itself and runs one step
// per character across a few statically assigned lanes. Everything per-character
// — token refresh, the per-character heartbeat pair, the per-endpoint
// fault-isolation, the wallet/location/implant/ship upserts and the clone SCD-2
// reconcile — stays inside the untouched job module (runCharacterStatus →
// forEachCharacterAnyScope in src/jobs/lib.js).
//
// Only the *scheduled* trigger moves here. The on-demand "Refresh ESI" path
// (dispatchRefresh's PER_CHARACTER_JOBS) still enqueues this job through the
// queue; the job module is CLI-runnable too.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCharacters } from './lib'

// The six ESI scopes character-status fronts (wallet, location, implants,
// clones, ship, skills). Keep in sync with SCOPES in src/jobs/characterStatus.js
// and the hardcoded list the cron route used to pass. The lane count: four keeps
// a big account polite to ESI's error-rate limits (the queue already ran
// per-character pulls concurrently, so this is nothing new).
const SCOPES = [
  'esi-wallet.read_character_wallet.v1',
  'esi-location.read_location.v1',
  'esi-clones.read_implants.v1',
  'esi-clones.read_clones.v1',
  'esi-location.read_ship_type.v1',
  'esi-skills.read_skills.v1',
]
const LANES = 4

// Step: run the job for one character. The lazy import is the usual reason (the
// job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCharacterAnyScope still refreshes the token, records the
// per-character heartbeat pair, and runs only the endpoints the token carries.
// characterId is a bigint-derived number — the only thing crossing the step
// boundary, and serializable.
async function syncCharacter(characterId: number) {
  'use step'
  const { runCharacterStatus } = await import('@/jobs/characterStatus.js')
  await runCharacterStatus({ characterIds: [characterId] })
}

export async function characterStatusWorkflow() {
  'use workflow'
  // The workflow body must stay deterministic control flow over step calls (the
  // 'use workflow' directive compiles it — see sdeMirror.ts). Ramda's pure
  // combinators are fine here: they're referentially transparent (identical on
  // every replay) and pull in no Node modules, unlike a workflow-level helper
  // that would run impure/Node code in workflow context.
  const ids = await enumerateCharacters(SCOPES)

  // Round-robin the characters into LANES lanes: splitEvery chunks the ids into
  // rows of LANES, then transpose flips rows→columns, so column j collects
  // every id at position j, j+LANES, … — i.e. id i lands in lane i % LANES, with
  // no empty trailing lanes when there are fewer ids than lanes. The mapping is
  // identical on every replay regardless of how the runtime resolves in-flight
  // steps. Within a lane characters run sequentially; lanes run concurrently.
  const lanes = transpose(splitEvery(LANES, ids))

  // Drain each lane sequentially (the forEachSequential promise-chain: reduce a
  // Promise.resolve() through the lane, each id awaiting the previous — inlined
  // because src/jobs/lib.js can't be imported into workflow context). A step
  // that exhausts its bounded retries (e.g. a character whose token is dead)
  // should be *visible*, not silently re-looped the way the queue did, but must
  // not abort its lane-mates — so each failure is caught (and logged as it
  // happens) and collected, then once every lane drains the collected ids are
  // mapped to one Error each and thrown together as an AggregateError, marking
  // the run failed in Observability. All characters are attempted regardless of
  // how the runtime treats a rejection inside Promise.all.
  const failures: number[] = []
  const drainLane = (lane: number[]): Promise<void> =>
    reduce(
      (p, id) =>
        p.then(() =>
          syncCharacter(id).catch((err) => {
            console.error(`[character-status] character ${id} failed:`, err)
            failures.push(id)
          }),
        ),
      Promise.resolve(),
      lane,
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    throw new AggregateError(
      map((id) => new Error(`character ${id} failed`), failures),
      `character-status: ${failures.length} character step(s) failed`,
    )
  }
}
