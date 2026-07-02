import { chain, filter, map, prop } from 'ramda'

import { industrySystems } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli } from './lib.js'

const TAG = 'industry-systems'

// PostgREST caps a single select; page through the source tables so a large
// number of structures or watchers doesn't silently truncate the set of systems
// we care about.
const SYSTEM_PAGE = 1000

// Distinct system ids from one column of one table, paged past the row cap.
const collectSystemIds = async (into, table, column) => {
  for (let from = 0; ; from += SYSTEM_PAGE) {
    const { data: rows, error } = await sudoSupabase
      .from(table)
      .select(column)
      .range(from, from + SYSTEM_PAGE - 1)
    if (error) throw error
    if (!rows || rows.length === 0) break
    for (const r of rows) {
      const id = Number(r[column])
      if (Number.isFinite(id)) into.add(id)
    }
    if (rows.length < SYSTEM_PAGE) break
  }
}

// GET /industry/systems/ → industry_system_index. Records a snapshot of the
// industry cost indices for every solar system we care about: the union of the
// systems we have a structure anchored in (corp_structure) and every system any
// user has put on their watch list (watched_system, the /indexes page). The
// endpoint is public (no token) and returns the indices for *all* systems in
// one shot, so we fetch it once and keep only the tracked systems. Each run
// appends a fresh set of rows, building a history of how the indices drift.
// Account-wide work, so it takes no character scope.
export const runIndustrySystems = async () => {
  const systemIds = new Set()
  await collectSystemIds(systemIds, 'corp_structure', 'system_id')
  const structureCount = systemIds.size
  await collectSystemIds(systemIds, 'watched_system', 'system_id')

  console.log(
    `[${TAG}] tracking ${systemIds.size} system(s) (${structureCount} with structures, ${systemIds.size - structureCount} watched only)`
  )
  if (systemIds.size === 0) return

  const systems = await industrySystems()
  const recorded_at = new Date().toISOString()
  const rows = chain((s) => {
    const system_id = Number(s?.solar_system_id)
    if (!systemIds.has(system_id)) return []
    return map(
      (ci) => ({ system_id, activity: ci.activity, cost_index: ci.cost_index ?? null, recorded_at }),
      filter(prop('activity'), s?.cost_indices ?? [])
    )
  }, systems ?? [])

  if (rows.length === 0) {
    console.log(`[${TAG}] no matching systems returned by ESI, nothing to record`)
    return
  }

  const { error: insertErr } = await sudoSupabase.from('industry_system_index').insert(rows)
  if (insertErr) {
    console.error(`[${TAG}] insert FAILED: ${insertErr.message}`)
    throw insertErr
  }
  console.log(`[${TAG}] recorded ${rows.length} industry index row(s)`)
}

cli(import.meta.url, TAG, runIndustrySystems)
