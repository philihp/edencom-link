import { chain, filter, map, prop } from 'ramda'

import { industrySystems } from './esi.js'
import { sudoSupabase } from './supabase.js'

// PostgREST caps a single select; page through corp_structure so a large number
// of structures doesn't silently truncate the set of systems we care about.
const SYSTEM_PAGE = 1000

// Record a snapshot of the industry cost indices for every solar system we have a
// structure anchored in. The /industry/systems/ endpoint is public and returns
// the indices for *all* systems in one shot, so we fetch it once and keep only
// the systems that appear in corp_structure. Each run appends a fresh set of
// rows to industry_system_index, building a history of how the indices drift.
export const pullIndustryIndexes = async () => {
  // Distinct systems we hold structures in. Read corp_structure (the base table
  // service_role can reach) paged so a large fleet isn't truncated.
  const systemIds = new Set()
  for (let from = 0; ; from += SYSTEM_PAGE) {
    const { data: rows, error } = await sudoSupabase
      .from('corp_structure')
      .select('system_id')
      .range(from, from + SYSTEM_PAGE - 1)
    if (error) throw error
    if (!rows || rows.length === 0) break
    for (const r of rows) {
      const id = Number(r.system_id)
      if (Number.isFinite(id)) systemIds.add(id)
    }
    if (rows.length < SYSTEM_PAGE) break
  }

  console.log(`[industry_index] ${systemIds.size} system(s) with structures`)
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
    console.log('[industry_index] no matching systems returned by ESI, nothing to record')
    return
  }

  const { error: insertErr } = await sudoSupabase.from('industry_system_index').insert(rows)
  if (insertErr) {
    console.error(`[industry_index] insert FAILED: ${insertErr.message}`)
    throw insertErr
  }
  console.log(`[industry_index] recorded ${rows.length} industry index row(s)`)
}
