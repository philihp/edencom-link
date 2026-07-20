'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'
import { createServiceClient } from '@/utils/supabase/service'

// Reconcile which corporations the caller shares their Mercenary Den data
// with — both their own deployed dens and any enemy-den intel they report
// (mercenary_den_enemy_intel gates visibility off this same preference). One
// row per (character, chosen corp), independent of whether that character has
// a den deployed right now. character_mercenary_den_share is RLS-free for
// writes (authenticated has no insert/update/delete grant), so writes go
// through the service role — scoped here to corporations the caller actually
// owns a character in. Returns { error } on failure.
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

  // Replace this user's shares wholesale: clear their existing rows, then insert
  // the desired (character × chosen corp) set.
  const { error: delError } = await service
    .from('character_mercenary_den_share')
    .delete()
    .in('character_id', registrationIds)
  if (delError) {
    return { error: delError.message }
  }

  if (corps.length > 0) {
    const rows = registrationIds.flatMap((character_id) =>
      corps.map((corporation_id) => ({ character_id, corporation_id }))
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
  reinforcementEnd: string
  notes: string
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
  if (!system || !planet) {
    return { error: 'System and planet are required' }
  }

  // reported_by is always the caller's main character (falling back to any
  // registered character) — derived server-side, never client-supplied, so it
  // can't be spoofed. RLS lets the user read their own registrations.
  const { data: mainReg } = await supabase
    .from('registration')
    .select('name')
    .eq('user_id', user.id)
    .order('is_main', { ascending: false })
    .limit(1)
    .maybeSingle()
  const reportedBy = mainReg?.name?.trim()
  if (!reportedBy) {
    return { error: 'Register a character before reporting sightings' }
  }

  // The reinforcement time is entered as EVE/UTC ISO 8601 with seconds
  // ("YYYY-MM-DDTHH:MM:SS" — the clock every pilot is already reading in-game),
  // not the browser's local timezone, so it's stamped with a literal "Z"
  // rather than passed through Date parsing, which would apply the browser's
  // offset. A space separator is accepted in place of the "T"; seconds are
  // required.
  let reinforcementEnd: string | null = null
  const rawReinforcement = input.reinforcementEnd.trim()
  if (rawReinforcement) {
    const iso = rawReinforcement.replace(' ', 'T')
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(iso)) {
      return { error: 'Reinforcement time must be ISO 8601 with seconds, e.g. 2026-07-20T14:30:45 (UTC)' }
    }
    reinforcementEnd = `${iso}Z`
  }

  const { error } = await supabase.from('mercenary_den_enemy_intel').insert({
    system,
    planet,
    owner: input.owner.trim() || null,
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
