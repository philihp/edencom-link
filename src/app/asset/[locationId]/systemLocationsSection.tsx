import type { SupabaseClient } from '@supabase/supabase-js'

import type { Owners } from '../../ownerFilter'
import { resolveLocations, type LocationRef } from '../../resolveLocations'
import { type Location } from '../assetsTable'
import { SystemLocations } from './systemLocations'

// A row from the *_asset_location_summary() RPCs, normalized to whoever owns
// the stacks (a character registration uuid or an EVE corporation id).
type SummaryRow = {
  location_id: number | string
  location_type: string | null
  owner_id: string
  stacks: number | string
}

// For a solar system, the items parked in its stations/structures live under
// those locations (location_id = station/structure), not the system id, so the
// root-item query only surfaces things floating in space. This lists every
// station/structure in the system where we hold assets as a navigable
// directory, built from the same RLS-scoped location-summary RPCs the index
// page uses.
//
// Its own async server component because those RPCs are the most expensive
// thing on the page by a wide margin — unlike the contents counts, which walk
// one location's subtree, these walk *every* asset the caller can see to bucket
// it by location. Streaming it keeps a system page's heading and in-space items
// from waiting on a whole-hangar sweep.
//
// Authenticated path only: those RPCs walk unscoped as service_role, and a
// share token is always bound to a single item.
export const SystemLocationsSection = async ({
  supabase,
  locationId,
  systemId,
  owners,
}: {
  supabase: SupabaseClient
  locationId: string
  systemId: number
  owners: Owners
}) => {
  const [{ data: characterSummary }, { data: corpSummary }] = await Promise.all([
    supabase.rpc('character_asset_location_summary'),
    supabase.rpc('corp_asset_location_summary'),
  ])
  const summary: SummaryRow[] = [
    ...((characterSummary ?? []) as Array<Omit<SummaryRow, 'owner_id'> & { registration_id: string }>).map(
      ({ registration_id, ...r }) => ({ ...r, owner_id: registration_id })
    ),
    ...((corpSummary ?? []) as Array<Omit<SummaryRow, 'owner_id'> & { corporation_id: number | string }>).map(
      ({ corporation_id, ...r }) => ({ ...r, owner_id: String(corporation_id) })
    ),
  ]

  // Tally stacks per location/owner, dropping the system's own space bucket
  // (its items are already shown inline below, and it would self-link).
  const byLocation = new Map<string, { root: LocationRef; counts: Map<string, number> }>()
  for (const row of summary) {
    const id = String(row.location_id)
    if (id === locationId) continue
    const entry = byLocation.get(id) ?? { root: { id, type: row.location_type }, counts: new Map() }
    entry.counts.set(row.owner_id, (entry.counts.get(row.owner_id) ?? 0) + Number(row.stacks))
    byLocation.set(id, entry)
  }
  const entries = [...byLocation.values()]
  const { nameFor, systemIdFor } = await resolveLocations(
    entries.map(({ root }) => root),
    supabase
  )
  const locations: Location[] = entries
    .filter(({ root }) => systemIdFor(root) === systemId)
    .map(({ root, counts }) => ({
      id: root.id,
      name: nameFor(root),
      system: null,
      counts: Object.fromEntries(counts),
    }))

  return <SystemLocations locations={locations} owners={owners} />
}
