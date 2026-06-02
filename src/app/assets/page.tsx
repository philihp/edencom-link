import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { DateTime } from '../DateTime'
import retro from '../retro.module.css'
import { fetchStationNames, fetchStationSystems } from '../stationNames'
import { fetchSystemNames } from '../systemNames'
import styles from './assets.module.css'

// Bigint ids arrive from PostgREST as strings, so every id is kept as a string
// and only converted to a number at the API/system-lookup boundary.
type Asset = {
  item_id: number | string
  location_id: number | string | null
  location_type: string | null
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

  // PostgREST caps a single select (Supabase's default API "Max rows" is 1000), but a
  // hangar can hold tens of thousands of items. The location buckets are built by walking
  // each item up its location_id chain through the items we own, so a truncated set breaks
  // the walk: it stops at an intermediate ship/container whose own row was past the cap and
  // emits that item id as a phantom `Location #…`. Page through every current asset first.
  const PAGE = 1000
  const list: Asset[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('asset')
      .select('item_id, location_id, location_type')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    list.push(...(data as Asset[]))
    if (data.length < PAGE) break
  }
  const assetByItem = new Map(list.map((a) => [String(a.item_id), a]))

  const rootLocation = (a: Asset): Root | null => {
    let cur: Asset | undefined = a
    const seen = new Set<string>()
    while (cur && cur.location_id != null) {
      const key = String(cur.location_id)
      const parent = assetByItem.get(key)
      // Parent isn't one of our items (or we've looped) — cur sits directly in
      // this location, so it's the root.
      if (!parent || seen.has(key)) return { id: key, type: cur.location_type }
      seen.add(key)
      cur = parent
    }
    return null
  }

  // Tally how many item stacks resolve to each location.
  const byLocation = new Map<string, Root & { count: number }>()
  for (const a of list) {
    const root = rootLocation(a)
    if (!root) continue
    const existing = byLocation.get(root.id)
    if (existing) existing.count += 1
    else byLocation.set(root.id, { ...root, count: 1 })
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

  // NPC station names come from eve-build-calculator (same curated source as the
  // type/system lookups); player structures aren't there, so those still resolve
  // via corp_structure above.
  const stationIds = [...byLocation.values()].filter((loc) => loc.type === 'station').map((loc) => Number(loc.id))
  const [stationNames, stationSystems] = await Promise.all([fetchStationNames(stationIds), fetchStationSystems(stationIds)])

  const systemIds = new Set<number>()
  for (const loc of byLocation.values()) {
    if (loc.type === 'solar_system') systemIds.add(Number(loc.id))
    const structure = structureById.get(loc.id)
    if (structure?.system_id != null) systemIds.add(Number(structure.system_id))
    // NPC stations aren't in corp_structure/structure; their system comes from
    // the calculator's station lookup above.
    if (loc.type === 'station' && stationSystems[Number(loc.id)] != null) systemIds.add(stationSystems[Number(loc.id)])
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

  // Busiest locations first, then by name for a stable order.
  const rows = [...byLocation.values()].sort((a, b) => b.count - a.count || labelFor(a).localeCompare(labelFor(b)))

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
      <h1>Assets</h1>
      {rows.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Location</th>
              <th>System</th>
              <th className={retro.num}>Items</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((loc) => {
              const system = systemFor(loc)
              const name = labelFor(loc)
              return (
                <tr key={`location-${loc.id}`}>
                  <td className="serif">{name}</td>
                  <td className="serif">{system && system !== name ? system : '—'}</td>
                  <td className={retro.num}>{loc.count}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : (
        <p>
          No assets visible. Link a character with the <code>esi-assets.read_assets.v1</code> scope on the{' '}
          <a href="/character">Characters</a> page so the hourly job can fetch them.
        </p>
      )}
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
export default AssetsPage
