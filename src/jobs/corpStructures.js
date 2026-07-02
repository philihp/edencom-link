import { corpStructures } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation } from './lib.js'

const TAG = 'corp-structures'
const SCOPE = 'esi-corporations.read_structures.v1'

// GET /corporations/{id}/structures/ → corp_structure. Upserts the corp's
// Upwell structures (state, fuel, reinforcement windows, services).
export const runCorpStructures = ({ characterIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, characterIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()
    const all = await fetchAllPages((page) => corpStructures(access_token, corporation_id, page))

    const now = new Date().toISOString()
    const rows = all.map((s) => ({
      structure_id: s.structure_id,
      corporation_id: s.corporation_id,
      type_id: s.type_id,
      system_id: s.system_id,
      profile_id: s.profile_id ?? null,
      name: s.name ?? null,
      state: s.state ?? null,
      fuel_expires: s.fuel_expires ?? null,
      unanchors_at: s.unanchors_at ?? null,
      reinforce_hour: s.reinforce_hour ?? null,
      next_reinforce_hour: s.next_reinforce_hour ?? null,
      next_reinforce_apply: s.next_reinforce_apply ?? null,
      next_reinforce_weekday: s.next_reinforce_weekday ?? null,
      services: s.services ?? null,
      last_seen_at: now,
      updated_at: now,
    }))

    if (rows.length > 0) {
      const { error } = await sudoSupabase.from('corp_structure').upsert(rows, { onConflict: 'structure_id' })
      if (error) throw error
    }
    console.log(`[${TAG}] ${ctx}: corp ${corporation_id} ${rows.length} structure(s) in ${Date.now() - t0}ms`)
  })

cli(import.meta.url, TAG, runCorpStructures)
