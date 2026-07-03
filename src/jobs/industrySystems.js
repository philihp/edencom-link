import { chain, filter, map, pipe, prop, uniq } from 'ramda'

import { industrySystems } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli } from './lib.js'

const TAG = 'industry-systems'

// PostgREST caps a single select; page through the source tables so a large
// number of structures or watchers doesn't silently truncate the set of systems
// we care about.
const SYSTEM_PAGE = 1000

// One table's system_id rows, drained past the PostgREST row cap by recursing
// on the next page until a short page signals the end.
const fetchSystemIdRows = async (table, from = 0) => {
  const { data: rows, error } = await sudoSupabase
    .from(table)
    .select('system_id')
    .range(from, from + SYSTEM_PAGE - 1)
  if (error) throw error
  const page = rows ?? []
  if (page.length < SYSTEM_PAGE) return page
  return [...page, ...(await fetchSystemIdRows(table, from + SYSTEM_PAGE))]
}

// Distinct, finite system ids from one table's system_id column.
const collectSystemIds = async (table) =>
  pipe(map(prop('system_id')), map(Number), filter(Number.isFinite), uniq)(await fetchSystemIdRows(table))

// GET /industry/systems/ → industry_system_index. Records a snapshot of the
// industry cost indices for every solar system we care about: the union of the
// systems we have a structure anchored in (corp_structure) and every system any
// user has put on their watch list (watched_system, the /indexes page). The
// endpoint is public (no token) and returns the indices for *all* systems in
// one shot, so we fetch it once and keep only the tracked systems. Each run
// appends a fresh set of rows, building a history of how the indices drift.
// Account-wide work, so it takes no character scope.
export const runIndustrySystems = async () => {
  const structureSystemIds = await collectSystemIds('corp_structure')
  const watchedSystemIds = await collectSystemIds('watched_system')
  const systemIds = new Set([...structureSystemIds, ...watchedSystemIds])

  console.log(
    `[${TAG}] tracking ${systemIds.size} system(s) (${structureSystemIds.length} with structures, ${systemIds.size - structureSystemIds.length} watched only)`
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
