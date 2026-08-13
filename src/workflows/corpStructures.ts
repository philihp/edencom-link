// corp-structures as a Vercel Workflow, in the per-corporation fan-out shape
// (docs/cron-to-workflows/04-per-corporation.md), copied from corpAssets.ts.
//
// It was a single step for as long as it was scheduled-only. It became
// on-demand with the structure-universe work (docs/structure-universe/design.md):
// "refresh my structures" fans this out alongside corp-assets, because the two
// carry different halves of a structure — this one brings state, services,
// reinforcement windows and the fuel timer, while the *rigs* come from corp
// assets (ESI has no structure-fitting endpoint; corpAssets.js reads items
// whose location_flag is a RigSlot). Dispatching only one of the pair leaves
// the other half visibly stale.
//
// The fan-out unit is the corporation, never the character: a corp's characters
// ride together in one step so two directors in the same corp can't race a
// concurrent reconcile, and only *different* corps run concurrently. Both
// triggers start() this — the cron route bare, the on-demand path with an
// OnDemandTarget carrying one corp's whole character group plus its
// refresh_task row. The job module is untouched and still CLI-runnable.

import { map, reduce, splitEvery, transpose } from 'ramda'

import { enumerateCorporations, type OnDemandTarget } from './lib'

// This job's ESI scope, and the lane count. Two lanes, matching corp-assets:
// the corp count is small, and one structures pull is far lighter than a
// paginated hangar.
const SCOPE = 'esi-corporations.read_structures.v1'
const LANES = 2

// Step: run the job for one corp group. The lazy import is the usual reason
// (the job module's top-level supabase/esi setup needs env vars absent at build
// time). forEachCorporation still refreshes tokens, dedupes to one handler call
// per corp, falls back through the group on a role denial, records the per-corp
// heartbeat pair, and now also records corp_job_access — which is what lets the
// fuel policy tell a director from a rank-and-file member.
async function syncCorporation(registrationIds: string[], taskId?: string) {
  'use step'
  const { withRefreshTask } = await import('./lib')
  const { runCorpStructures } = await import('@/jobs/corpStructures.js')
  await withRefreshTask(taskId, () => runCorpStructures({ registrationIds }))
}

export async function corpStructuresWorkflow(target?: OnDemandTarget) {
  'use workflow'
  const groups = target?.registrationIds ? [target.registrationIds] : await enumerateCorporations(SCOPE)

  // Round-robin the corp groups into LANES lanes; the mapping is identical on
  // every replay. Within a lane groups run sequentially; lanes run concurrently,
  // and only ever parallelize *different* corps.
  const lanes = transpose(splitEvery(LANES, groups))

  // Drain each lane sequentially, collecting rather than propagating failures so
  // one bad corp never aborts its lane-mates, then throw them together as an
  // AggregateError so the run is visibly failed in Observability.
  const failures: string[][] = []
  const drainLane = (lane: string[][]): Promise<void> =>
    reduce(
      (p, group) =>
        p.then(() =>
          syncCorporation(group, target?.taskId).catch((err) => {
            console.error(`[corp-structures] corp group [${group.join(', ')}] failed:`, err)
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
      `corp-structures: ${failures.length} corp step(s) failed`
    )
  }
}
