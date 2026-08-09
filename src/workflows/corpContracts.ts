// corp-contracts as a Vercel Workflow — the per-corporation fan-out shape
// established by corpWalletTransactions.ts, which this copies. The fan-out unit
// is a *corp group*, not a character: enumerateCorporations (./lib) returns one
// group per corporation (the ordered character list forEachCorporation dedupes
// to a single handler call, falling back through them if the first lacks the
// in-game role the endpoint separately requires) plus a singleton group per
// character whose corp isn't resolved yet. A corp's characters ride together in
// one step and a corp is never split across steps.
//
// corp_contract is an upsert-in-place table with no SCD-2 reconcile, so a
// retried or replayed step is harmlessly idempotent.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCorporations, type OnDemandTarget } from './lib'

// This job's ESI scope, and the lane count. Only *different* corps run
// concurrently; two lanes, matching the other per-corp jobs.
const SCOPE = 'esi-contracts.read_corporation_contracts.v1'
const LANES = 2

// Step: run the job for one corp group. Lazy import for the usual build-time
// env-vars reason; forEachCorporation still refreshes tokens, dedupes to one
// handler call per corp, and records the per-corp heartbeat pair.
async function syncCorporation(registrationIds: string[], taskId?: string) {
  'use step'
  const { withRefreshTask } = await import('./lib')
  const { runCorpContracts } = await import('@/jobs/corpContracts.js')
  await withRefreshTask(taskId, () => runCorpContracts({ registrationIds }))
}

export async function corpContractsWorkflow(target?: OnDemandTarget) {
  'use workflow'
  const groups = target?.registrationIds ? [target.registrationIds] : await enumerateCorporations(SCOPE)

  // Round-robin the corp groups into LANES lanes; identical on every replay.
  // Lanes only ever parallelize *different* corps, never the same corp.
  const lanes = transpose(splitEvery(LANES, groups))

  const failures: string[][] = []
  const drainLane = (lane: string[][]): Promise<void> =>
    reduce(
      (p, group) =>
        p.then(() =>
          syncCorporation(group, target?.taskId).catch((err) => {
            console.error(`[corp-contracts] corp group [${group.join(', ')}] failed:`, err)
            failures.push(group)
          })
        ),
      Promise.resolve(),
      lane
    )
  await Promise.all(map(drainLane, lanes))

  if (failures.length > 0) {
    throw new AggregateError(
      map((group) => new Error(`corp group [${group.join(', ')}] failed`), failures),
      `corp-contracts: ${failures.length} corp step(s) failed`
    )
  }
}
