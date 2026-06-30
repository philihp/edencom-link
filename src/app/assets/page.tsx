import { redirect } from 'next/navigation'
import { Suspense } from 'react'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
import { fetchStationNames, fetchStationSystems } from '../stationNames'
import { fetchSystemNames } from '../systemNames'
import styles from './assets.module.css'
import { AssetsTable, type Location } from './assetsTable'

// Bigint ids arrive from PostgREST as strings, so every id is kept as a string
// and only converted to a number at the API/system-lookup boundary.
type SummaryRow = {
  location_id: number | string
  location_type: string | null
  character_id: string
  stacks: number | string
}

type Structure = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
}

// The place an item ultimately sits. Items can be nested (a module in a ship in
// a station), so the root is found by walking location_id up through any parent
// items we also own until it points at something that isn't one of our items —
// a station, structure, or solar system.
type Root = { id: string; type: string | null }

const AssetsPage = async () => {
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // The location buckets are expensive to build (every asset is paged in and walked
  // up its location chain, then station/structure/system names are resolved), so the
  // page shell streams immediately and the table streams in once Locations() resolves.
  return (
    <Suspense fallback={<AssetsLoading />}>
      <Locations />
    </Suspense>
  )
}
export default AssetsPage

const AssetsLoading = () => (
  <section>
    <div className={styles.header}>
      <h1>Assets</h1>
    </div>
    <p>Loading locations…</p>
  </section>
)

const Locations = async () => {
  const supabase = await createClient()

  // A hangar can hold tens of thousands of nested items; paging them all into
  // Node and walking the location_id chains here timed the page out. The
  // asset_location_summary() function does the walk in Postgres and returns one
  // small row per location/character pair instead (RLS still scopes it to us).
  const { data: summary } = await supabase.rpc('asset_location_summary')

  const { data: characters } = await supabase.from('registration').select('id, name')
  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  // Tally stacks per location, split by the character that owns each stack so
  // the client can filter by character.
  const byLocation = new Map<string, { root: Root; counts: Map<string, number> }>()
  for (const row of (summary ?? []) as SummaryRow[]) {
    const id = String(row.location_id)
    const entry = byLocation.get(id) ?? { root: { id, type: row.location_type }, counts: new Map<string, number>() }
    entry.counts.set(row.character_id, (entry.counts.get(row.character_id) ?? 0) + Number(row.stacks))
    byLocation.set(id, entry)
  }

  // Structure names + systems come from two caches: our own corp's structures
  // (corp_structure) and foreign player structures characters hold assets in,
  // resolved from ESI by the structures job (public.structure). Own-corp entries
  // win on overlap. In-space `solar_system` locations are the system itself.
  const locationIds = [...byLocation.keys()].map(Number).filter((n) => Number.isFinite(n))

  const { data: corpStructures } = await supabase.from('corp_structure').select('structure_id, name, system_id')
  const { data: playerStructures } = locationIds.length
    ? await supabase.from('structure').select('structure_id, name, system_id').in('structure_id', locationIds)
    : { data: [] }

  const structureById = new Map<string, Structure>()
  for (const s of (playerStructures ?? []) as Structure[]) structureById.set(String(s.structure_id), s)
  // Own-corp structures override the ESI-resolved cache.
  for (const s of (corpStructures ?? []) as Structure[]) structureById.set(String(s.structure_id), s)

  // NPC station names come from the eve_name DB cache; player structures aren't
  // there, so those still resolve via corp_structure above.
  const stationIds = [...byLocation.values()]
    .filter(({ root }) => root.type === 'station')
    .map(({ root }) => Number(root.id))
  const [stationNames, stationSystems] = await Promise.all([fetchStationNames(stationIds), fetchStationSystems(stationIds)])

  const systemIds = new Set<number>()
  for (const { root } of byLocation.values()) {
    if (root.type === 'solar_system') systemIds.add(Number(root.id))
    const structure = structureById.get(root.id)
    if (structure?.system_id != null) systemIds.add(Number(structure.system_id))
    // NPC stations aren't in corp_structure/structure; their system comes from
    // the calculator's station lookup above.
    if (root.type === 'station' && stationSystems[Number(root.id)] != null) systemIds.add(stationSystems[Number(root.id)])
  }
  const systemNames = await fetchSystemNames(systemIds)

  const labelFor = (loc: Root): string => {
    const structure = structureById.get(loc.id)
    if (structure) return structure.name ?? `Structure #${loc.id}`
    if (loc.type === 'station') return stationNames[Number(loc.id)] ?? `Station #${loc.id}`
    if (loc.type === 'solar_system') return systemNames[Number(loc.id)] ?? `System #${loc.id}`
    return `Location #${loc.id}`
  }

  const systemFor = (loc: Root): string | undefined => {
    const structure = structureById.get(loc.id)
    if (structure?.system_id != null) return systemNames[Number(structure.system_id)] ?? `#${structure.system_id}`
    if (loc.type === 'solar_system') return systemNames[Number(loc.id)]
    if (loc.type === 'station') {
      const systemId = stationSystems[Number(loc.id)]
      if (systemId != null) return systemNames[systemId] ?? `#${systemId}`
    }
    return undefined
  }

  const locations: Location[] = [...byLocation.values()].map(({ root, counts }) => ({
    id: root.id,
    name: labelFor(root),
    system: systemFor(root) ?? null,
    counts: Object.fromEntries(counts),
  }))

  // When the Assets background job last finished. Each scheduled run writes a
  // public.heartbeat row stamped with ended_at and a link to the workflow run; we
  // read back the most recent completed one.
  const { data: lastRun } = await supabase
    .from('heartbeat')
    .select('ended_at, run_url')
    .eq('job', 'assets')
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return (
    <>
      <AssetsTable locations={locations} characters={sortedCharacters} />
      <p className={styles.lastRun}>
        Assets last refreshed:{' '}
        {lastRun?.run_url ? (
          <a href={lastRun.run_url}>
            <DateTime value={lastRun.ended_at} fallback="never" />
          </a>
        ) : (
          <DateTime value={lastRun?.ended_at} fallback="never" />
        )}
      </p>
    </>
  )
}
