import { redirect } from 'next/navigation'

import { getSdeTypes } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'
import { fetchOwners } from '../owners'
import type { Owner } from '../ownerFilter'
import { fittingRoute, type FittingRow } from './fit'
import { FittingMatrix, type FittingEntry } from './fittingMatrix'

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
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const [{ data: fittings }, owners] = await Promise.all([
    supabase
      .from('character_fitting')
      .select('character_id, fitting_id, name, description, ship_type_id, items')
      .returns<FittingRow[]>(),
    // Every registration the caller owns, so a character with no saved fits
    // still appears in the filter — the assets owner select behaves the same.
    // Corporations are ignored: ESI has no corp fittings endpoint, so every
    // row here is character-owned (docs/fittings.md).
    fetchOwners(),
  ])
  const rows = fittings ?? []
  const ownIds = new Set(owners.characters.map((c) => c.id))

  // character_directory names only the fits shared in from elsewhere need —
  // the world-readable registration_id → name lookup (see
  // docs/sharing-layer/design.md), fetched just for those character_ids.
  const sharedInCharacterIds = [...new Set(rows.filter((f) => !ownIds.has(f.character_id)).map((f) => f.character_id))]
  const { data: directory } =
    sharedInCharacterIds.length > 0
      ? await supabase
          .from('character_directory')
          .select('registration_id, name')
          .in('registration_id', sharedInCharacterIds)
      : { data: [] as Array<{ registration_id: string; name: string | null }> }
  const ownerNameById = new Map((directory ?? []).map((d) => [d.registration_id, d.name]))
  const nameOf = (characterId: string) => ownerNameById.get(characterId) ?? 'unknown'

  const entries: FittingEntry[] = rows.map((f) => ({
    href: fittingRoute(f.character_id, f.fitting_id),
    name: f.name || `Fitting #${f.fitting_id}`,
    shipTypeId: Number(f.ship_type_id),
    ownerId: f.character_id,
    ...(ownIds.has(f.character_id) ? {} : { owner: nameOf(f.character_id) }),
  }))

  // Only the shared-in characters actually holding a visible fit — unlike the
  // caller's own, there's no roster to list them from.
  const sharedCharacters: Owner[] = sharedInCharacterIds
    .map((id) => ({ id, name: nameOf(id) }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // One bulk SDE lookup carries everything the matrix buckets by: hull name,
  // group (→ class row), race and meta group (→ column).
  const types = await getSdeTypes(entries.map((e) => e.shipTypeId))

  return (
    <FittingMatrix
      entries={entries}
      types={types}
      ownCharacters={owners.characters}
      sharedCharacters={sharedCharacters}
    />
  )
}

export default FittingPage
