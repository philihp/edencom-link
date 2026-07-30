// Translation between the two ids a fitting owner has, and the reason
// /fitting/[characterId]/[fittingId] can carry the EVE numeric character id
// while the tables key on a registration uuid.
//
// Two sources, because neither alone covers every owner the page can show:
//
//   * registration — RLS returns only the caller's own rows, so it answers
//     "is this me, and which registration is it" and nothing else. Its
//     character_id column is the EVE id (registration is one of the few
//     tables where that name is accurate).
//   * character_directory — world-readable, and the only place a *shared-in*
//     fit's owner can be resolved from. It names both ids unambiguously:
//     character_id (EVE, bigint) and registration_id (uuid).
//
// A registration whose character_id is still null resolves to nothing: no
// extract can have run for it (the job needs the EVE id to call ESI), so it
// owns no fittings to link to.
import type { SupabaseClient } from '@supabase/supabase-js'

export type FittingOwner = {
  registrationId: string
  // The EVE numeric character id, as a string — it's a bigint, and it only
  // ever gets concatenated into a URL or compared, never arithmetic.
  characterId: string
  name: string | null
  // True when the caller holds the registration, i.e. this is their own
  // character. RLS on `registration` is what proves it.
  isOwn: boolean
}

type RegistrationRow = { id: string; character_id: number | string | null; name: string | null }
type DirectoryRow = { registration_id: string; character_id: number | string | null; name: string | null }

// Resolve the owners behind a set of registration uuids (as stored on
// character_fitting rows), for building links and owner labels.
//
// Every one of the caller's own registrations comes back whether or not it
// appears in `registrationIds`, so the owner filter can offer a character who
// has saved no fits yet — the assets owner select behaves the same. Own rows
// win over directory rows for the same registration, since they prove
// ownership and carry the caller's own name for the character.
export const fetchFittingOwners = async (
  supabase: SupabaseClient,
  registrationIds: string[]
): Promise<Map<string, FittingOwner>> => {
  const owners = new Map<string, FittingOwner>()

  const [{ data: own }, { data: directory }] = await Promise.all([
    supabase.from('registration').select('id, character_id, name').returns<RegistrationRow[]>(),
    // An empty .in() list is not a valid PostgREST filter, so skip the query
    // entirely when there's nothing shared in to resolve.
    registrationIds.length > 0
      ? supabase
          .from('character_directory')
          .select('registration_id, character_id, name')
          .in('registration_id', registrationIds)
          .returns<DirectoryRow[]>()
      : Promise.resolve({ data: [] as DirectoryRow[] }),
  ])

  // Directory first, so an own registration overwrites it below.
  ;(directory ?? []).forEach((d) => {
    if (d.character_id == null) return
    owners.set(d.registration_id, {
      registrationId: d.registration_id,
      characterId: String(d.character_id),
      name: d.name,
      isOwn: false,
    })
  })
  ;(own ?? []).forEach((r) => {
    if (r.character_id == null) return
    owners.set(r.id, { registrationId: r.id, characterId: String(r.character_id), name: r.name, isOwn: true })
  })

  return owners
}

// The reverse, for the detail route: an EVE character id from the URL to the
// registration the fitting rows are keyed by. Returns null when the id names
// nobody this deployment knows — the caller should 404 rather than leak the
// difference between "no such character" and "no fit shared with you".
export const resolveFittingOwner = async (
  supabase: SupabaseClient,
  characterId: string
): Promise<FittingOwner | null> => {
  // Not a bigint, so it can't match either column — bail before PostgREST
  // rejects the filter outright.
  if (!/^\d+$/.test(characterId)) return null

  const { data: own } = await supabase
    .from('registration')
    .select('id, character_id, name')
    .eq('character_id', characterId)
    .maybeSingle<RegistrationRow>()
  if (own) {
    return { registrationId: own.id, characterId: String(own.character_id), name: own.name, isOwn: true }
  }

  const { data: directory } = await supabase
    .from('character_directory')
    .select('registration_id, character_id, name')
    .eq('character_id', characterId)
    .maybeSingle<DirectoryRow>()
  if (!directory?.registration_id) return null

  return {
    registrationId: directory.registration_id,
    characterId: String(directory.character_id),
    name: directory.name,
    isOwn: false,
  }
}
