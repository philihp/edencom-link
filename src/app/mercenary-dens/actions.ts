'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// Reconcile which corporations the caller shares ALL their mercenary dens with.
// Sharing writes one character_mercenary_den_share row per den per chosen corp; unsharing
// removes them. character_mercenary_den_share is RLS-free and authenticated has no write
// grant, so writes go through the service role — scoped here to the caller's own
// dens and restricted to corporations the caller actually owns a character in.
// Returns { error } on failure.
export const setSharedCorps = async (corpIds: number[]): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  const service = createServiceClient()

  // The caller's characters and the corps they belong to — they can only share
  // to corporations one of their own characters is in.
  const { data: regs } = await service.from('registration').select('id, corporation_id').eq('user_id', user.id)
  const registrationIds = (regs ?? []).map((r) => r.id)
  if (registrationIds.length === 0) return {}

  const ownCorps = new Set(
    (regs ?? [])
      .map((r) => r.corporation_id)
      .filter((c): c is number => c != null)
      .map(Number)
  )
  const corps = [...new Set(corpIds.map(Number))].filter((c) => ownCorps.has(c))

  // Every den the caller currently owns (current SCD rows).
  const { data: dens } = await service
    .from('character_mercenary_den_over_time')
    .select('character_id, den_id')
    .eq('is_current', true)
    .in('character_id', registrationIds)
  const denRows = (dens ?? []) as Array<{ character_id: string; den_id: number }>

  // Replace this user's shares wholesale: clear their existing rows, then insert
  // the desired (den × chosen corp) set.
  const { error: delError } = await service
    .from('character_mercenary_den_share')
    .delete()
    .in('character_id', registrationIds)
  if (delError) {
    return { error: delError.message }
  }

  if (corps.length > 0 && denRows.length > 0) {
    const rows = denRows.flatMap((d) =>
      corps.map((corporation_id) => ({ character_id: d.character_id, den_id: d.den_id, corporation_id }))
    )
    const { error: insError } = await service.from('character_mercenary_den_share').insert(rows)
    if (insError) {
      return { error: insError.message }
    }
  }

  revalidatePath('/mercenary-dens')
  return {}
}

export type EnemyDenIntelInput = {
  system: string
  planet: string
  owner: string
  alliance: string
  reinforcementEnd: string
  notes: string
  reportedBy: string
}

// Post one sighting to the shared enemy-den-intel corkboard (mercenary_den_enemy_intel).
// RLS lets any authenticated user insert a row attributed to themselves, so this
// runs on the cookie-session client rather than the service role. Returns
// { error } on failure.
export const addEnemyDenIntel = async (input: EnemyDenIntelInput): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  const system = input.system.trim()
  const planet = input.planet.trim()
  const owner = input.owner.trim()
  const reportedBy = input.reportedBy.trim()
  if (!system || !planet || !owner || !reportedBy) {
    return { error: 'System, planet, owner, and reported by are required' }
  }

  // The <input type="datetime-local"> value ("YYYY-MM-DDTHH:mm") is entered as
  // EVE/UTC time (that's the clock every pilot is already reading in-game), not
  // the browser's local timezone — so it's stamped with a literal "Z" rather
  // than passed through Date parsing, which would apply the browser's offset.
  const reinforcementEnd = input.reinforcementEnd ? `${input.reinforcementEnd}:00Z` : null

  const { error } = await supabase.from('mercenary_den_enemy_intel').insert({
    system,
    planet,
    owner,
    alliance: input.alliance.trim() || null,
    reinforcement_end: reinforcementEnd,
    notes: input.notes.trim() || null,
    reported_by: reportedBy,
    created_by: user.id,
  })
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/mercenary-dens')
  return {}
}

// Remove one sighting. RLS restricts deletion to the row's own submitter, so an
// attempt on someone else's row is simply a no-op rather than an error.
export const deleteEnemyDenIntel = async (id: number): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { error } = await supabase.from('mercenary_den_enemy_intel').delete().eq('id', id)
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/mercenary-dens')
  return {}
}
