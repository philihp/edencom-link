import { chain, filter, forEach, map, pipe, prop, splitEvery, uniq } from 'ramda'

import { industrySystems } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

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

// Player Upwell structure ids sit at or above this; same constant and reasoning
// as src/jobs/universeStructures.js.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// One industry-job table's location columns, drained past the row cap.
const fetchJobLocationRows = async (table, from = 0) => {
  const { data: rows, error } = await sudoSupabase
    .from(table)
    .select('station_id, facility_id')
    .order('job_id', { ascending: true })
    .range(from, from + SYSTEM_PAGE - 1)
  if (error) throw error
  const page = rows ?? []
  if (page.length < SYSTEM_PAGE) return page
  return [...page, ...(await fetchJobLocationRows(table, from + SYSTEM_PAGE))]
}

// Systems of the player structures our industry jobs run in — including the
// rented ones no director of ours scans, which is the whole point: /structure
// splits a job's cost into index fee / SCC / facility tax
// (src/app/structure/eiv.ts), and the index term needs a cost-index sample for
// the system the job actually ran in. Structures we own are already covered by
// corp_structure above; this adds the rest, resolved through the
// universe_structure directory (a structure the directory hasn't resolved
// contributes no system rather than blocking the run).
const collectJobStructureSystemIds = async () => {
  const jobRows = [
    ...(await fetchJobLocationRows('character_industry_job')),
    ...(await fetchJobLocationRows('corp_industry_job')),
  ]
  const structureIds = pipe(
    map((row) => Number(row.station_id ?? row.facility_id)),
    filter((id) => Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR),
    uniq
  )(jobRows)
  if (structureIds.length === 0) return []

  const systemIds = []
  await forEachSequential(splitEvery(500, structureIds), async (chunk) => {
    const { data, error } = await sudoSupabase
      .from('universe_structure')
      .select('system_id')
      .in('structure_id', chunk)
      .not('system_id', 'is', null)
    if (error) throw error
    forEach((row) => systemIds.push(Number(row.system_id)), data ?? [])
  })
  return uniq(filter(Number.isFinite, systemIds))
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
  const structureSystemIds = await collectSystemIds('corp_structure')
  const watchedSystemIds = await collectSystemIds('watched_system')
  const jobSystemIds = await collectJobStructureSystemIds()
  const systemIds = new Set([...structureSystemIds, ...watchedSystemIds, ...jobSystemIds])

  console.log(
    `[${TAG}] tracking ${systemIds.size} system(s) (${structureSystemIds.length} with structures, ` +
      `${watchedSystemIds.length} watched, ${jobSystemIds.length} with jobs of ours)`
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
