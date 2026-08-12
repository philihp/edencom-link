import { redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import type { Owner } from '../ownerFilter'
import { fittingRoute, type FittingRow } from './fit'
import { FittingMatrix, type FittingEntry } from './fittingMatrix'
import { fetchFittingOwners } from './resolveCharacter'

// Every saved fitting the signed-in player can see, laid out the way ship
// charts are: one row per hull class (Frigate → Battleship → Capital), one
// column per empire ship line plus Faction — see shipMatrix.ts for the
// bucketing, and fittingMatrix.tsx for the owner filter over it.
//
// RLS on character_fitting_over_time scopes this to more than just the
// caller's own registrations: a fit shared through character_fitting_share
// (by a corp/alliance mate, or by anyone at the public level — see schema.sql)
// is visible here too, since it's the same table and the same select. Entries
// not owned by one of the caller's own characters carry an `owner` label so
// the matrix stays honest about whose fit it's showing.
const FittingPage = async () => {
  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) redirect('/')

  const { data: fittings } = await supabase
    .from('character_fitting')
    .select('registration_id, fitting_id, name, description, ship_type_id, items')
    .returns<FittingRow[]>()
  const rows = fittings ?? []

  // Every owner behind a visible fit, resolved to the EVE character id the
  // route addresses them by (see resolveCharacter.ts). Own registrations come
  // back too, so the filter can list a character that has saved no fits yet.
  //
  // The hull lookup that follows keys off the fits' own ship_type_id, not off
  // anything the owner resolution produces, so the two run together rather than
  // one after the other. It covers every entry the matrix can build, since an
  // entry only ever comes from one of these rows.
  const [owners, types] = await Promise.all([
    fetchFittingOwners(supabase, [...new Set(rows.map((f) => f.registration_id))]),
    // One bulk SDE lookup carries everything the matrix buckets by: hull name,
    // group (→ class row), race and meta group (→ column).
    getSdeTypes(rows.map((f) => Number(f.ship_type_id))),
  ])

  const entries: FittingEntry[] = rows.flatMap((f) => {
    const owner = owners.get(f.registration_id)
    // An owner we can't name an EVE id for has no addressable URL; in practice
    // unreachable, since a fit only exists once the extract has run for them.
    if (!owner) return []
    return [
      {
        href: fittingRoute(owner.characterId, f.fitting_id),
        name: f.name || `Fitting #${f.fitting_id}`,
        shipTypeId: Number(f.ship_type_id),
        ownerId: owner.characterId,
        ...(owner.isOwn ? {} : { owner: owner.name ?? 'unknown' }),
      },
    ]
  })

  const toFilterOwner = (o: { characterId: string; name: string | null }): Owner => ({
    id: o.characterId,
    name: o.name ?? `Character #${o.characterId}`,
  })
  const byName = (a: Owner, b: Owner) => a.name.localeCompare(b.name)
  const all = [...owners.values()]
  const ownCharacters = all
    .filter((o) => o.isOwn)
    .map(toFilterOwner)
    .sort(byName)
  const sharedCharacters = all
    .filter((o) => !o.isOwn)
    .map(toFilterOwner)
    .sort(byName)

  return (
    <FittingMatrix entries={entries} types={types} ownCharacters={ownCharacters} sharedCharacters={sharedCharacters} />
  )
}

export default FittingPage
