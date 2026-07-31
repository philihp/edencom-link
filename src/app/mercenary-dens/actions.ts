'use server'

import { revalidatePath } from 'next/cache'

import { createClient } from '@/utils/supabase/server'

// Reconcile which alliances the caller shares their Mercenary Den data with —
// both their own deployed dens and any enemy-den intel they report
// (mercenary_den_enemy_intel resolves visibility through these same rows).
// Sharing is opt-in: no rows means shared with nobody.
//
// Rows are per (character, alliance) — the grantor is a registration, which is
// what the RLS policies match a den or a report against — but the UI is one
// choice for the whole account, so this writes every one of the caller's
// characters at once. RLS restricts both the read and the writes to the caller's
// own registrations, and an alliance can only be chosen if one of their
// characters is in it, so this runs on the cookie session client rather than the
// service role. Returns { error } on failure.
export const setSharedAlliances = async (allianceIds: number[]): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) {
    return { error: 'Not signed in' }
  }

  // RLS already scopes registration to the caller; the filter is belt-and-braces
  // so a policy change can't silently widen what this writes.
  const { data: regs, error: regError } = await supabase
    .from('registration')
    .select('id, corporation_id')
    .eq('user_id', user.id)
  if (regError) {
    return { error: regError.message }
  }
  const registrationIds = (regs ?? []).map((r) => r.id as string)
  if (registrationIds.length === 0) return {}

  // A user can only share with an alliance one of their own characters is in —
  // enforced here as well as being all the picker offers, so a hand-rolled
  // request can't aim a share at a third party.
  const ownCorpIds = [...new Set((regs ?? []).map((r) => r.corporation_id).filter((c): c is number => c != null))]
  const { data: myCorps } = ownCorpIds.length
    ? await supabase.from('corporation').select('alliance_id').in('corporation_id', ownCorpIds)
    : { data: [] }
  const ownAlliances = new Set(
    (myCorps ?? [])
      .map((c) => c.alliance_id)
      .filter((a): a is number => a != null)
      .map(Number)
  )
  const alliances = [...new Set(allianceIds.map(Number))].filter((a) => ownAlliances.has(a))

  // Replace this user's shares wholesale: clear their existing rows, then insert
  // the desired (character × chosen alliance) set.
  const { error: delError } = await supabase
    .from('character_mercenary_den_share')
    .delete()
    .in('registration_id', registrationIds)
  if (delError) {
    return { error: delError.message }
  }

  if (alliances.length > 0) {
    const rows = registrationIds.flatMap((registration_id) =>
      alliances.map((alliance_id) => ({ registration_id, alliance_id }))
    )
    const { error: insError } = await supabase.from('character_mercenary_den_share').insert(rows)
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

  // The report is attributed to the caller's main character (falling back to any
  // registered character) — derived server-side, never client-supplied, so it
  // can't be spoofed. RLS lets the user read their own registrations. reporter_id
  // is what carries ownership *and* audience: the sharing policy matches it
  // against character_mercenary_den_share rows, which an auth user id alone
  // can't be matched against. reported_by stays as the denormalized display name.
  const { data: mainReg } = await supabase
    .from('registration')
    .select('id, name')
    .eq('user_id', user.id)
    .order('is_main', { ascending: false })
    .limit(1)
    .maybeSingle()
  const reportedBy = mainReg?.name?.trim()
  if (!mainReg?.id || !reportedBy) {
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
    reporter_id: mainReg.id,
    created_by: user.id,
  })
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/mercenary-dens')
  return {}
}

// Soft-delete one sighting: stamp deleted_at rather than removing the row, so
// the record is retained (the /mercenary-dens query hides deleted_at rows).
// RLS restricts the update to the row's own submitter, so an attempt on someone
// else's row simply matches nothing.
export const deleteEnemyDenIntel = async (id: number): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { error } = await supabase
    .from('mercenary_den_enemy_intel')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    return { error: error.message }
  }

  revalidatePath('/mercenary-dens')
  return {}
}
