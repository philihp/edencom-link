import type { SupabaseClient } from '@supabase/supabase-js'
import { chain, uniqBy } from 'ramda'

// Who may manage a corporation's structure shares: a director, by observed
// capability (docs/sharing-layer/12-structure-share.md, "Who manages it") —
// a registration of the caller's that corp_job_access lists for
// (corporation, 'corp-structures') fetched this corporation's structures, so
// it held a Station Manager token. The same predicate the share table's
// owner policy and the fuel policy carry; evaluated here only to decide
// what to RENDER (the dialog, the toggle). RLS decides what is written.
//
// Both reads are RLS-scoped to the caller's own rows, so the answer never
// names anyone else's characters.

export type OwnRegistration = { id: string; corporation_id: number | string | null }

export type DirectorGrant = {
  // Which of the caller's registrations proved the role, for updated_by.
  registrationId: string
  corporationId: number
}

const DIRECTOR_JOB = 'corp-structures'

type AccessRow = { registration_id: string; corporation_id: number | string }

// Every corporation the caller directs, with the registration that proved it.
// The grant must still hold: the character has to be IN the corporation
// today, not merely have scanned it once.
export const fetchDirectorships = async (supabase: SupabaseClient): Promise<DirectorGrant[]> => {
  const [{ data: regs }, { data: access }] = await Promise.all([
    supabase.from('registration').select('id, corporation_id'),
    supabase.from('corp_job_access').select('registration_id, corporation_id').eq('job', DIRECTOR_JOB),
  ])
  const own = new Map(((regs ?? []) as OwnRegistration[]).map((r) => [r.id, r]))
  return uniqBy(
    (g: DirectorGrant) => g.corporationId,
    chain(
      (a: AccessRow): DirectorGrant[] => {
        const corporationId = Number(a.corporation_id)
        const reg = own.get(a.registration_id)
        return reg?.corporation_id != null && Number(reg.corporation_id) === corporationId
          ? [{ registrationId: a.registration_id, corporationId }]
          : []
      },
      (access ?? []) as AccessRow[]
    )
  )
}

export const directorOf = async (supabase: SupabaseClient, corporationId: number): Promise<DirectorGrant | null> =>
  (await fetchDirectorships(supabase)).find((g) => g.corporationId === corporationId) ?? null
