import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
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
  system_id: number | string
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

  const { data: assets } = await supabase
    .schema('hangar')
    .from('asset')
    .select('item_id, location_id, location_type')

  const list = (assets ?? []) as Asset[]
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

  // Names + systems for the locations we can resolve: our corp's structures from
  // the corp_structure table, and in-space `solar_system` locations whose id is
  // the system itself. NPC stations have no non-SDE source, so they show raw ids.
  const { data: structures } = await supabase
    .schema('hangar')
    .from('corp_structure')
    .select('structure_id, name, system_id')

  const structureById = new Map(((structures ?? []) as Structure[]).map((s) => [String(s.structure_id), s]))

  const systemIds = new Set<number>()
  for (const loc of byLocation.values()) {
    if (loc.type === 'solar_system') systemIds.add(Number(loc.id))
    const structure = structureById.get(loc.id)
    if (structure) systemIds.add(Number(structure.system_id))
  }
  const systemNames = await fetchSystemNames(systemIds)

  const labelFor = (loc: Root): string => {
    const structure = structureById.get(loc.id)
    if (structure) return structure.name ?? `Structure #${loc.id}`
    if (loc.type === 'solar_system') return systemNames[Number(loc.id)] ?? `System #${loc.id}`
    if (loc.type === 'station') return `Station #${loc.id}`
    return `Location #${loc.id}`
  }

  const systemFor = (loc: Root): string | undefined => {
    const structure = structureById.get(loc.id)
    if (structure) return systemNames[Number(structure.system_id)] ?? `#${structure.system_id}`
    if (loc.type === 'solar_system') return systemNames[Number(loc.id)]
    return undefined
  }

  // Busiest locations first, then by name for a stable order.
  const rows = [...byLocation.values()].sort((a, b) => b.count - a.count || labelFor(a).localeCompare(labelFor(b)))

  return (
    <>
      <h1>Assets</h1>
      {rows.length > 0 ? (
        <ul className={styles.grid}>
          {rows.map((loc) => {
            const system = systemFor(loc)
            const name = labelFor(loc)
            return (
              <li key={`location-${loc.id}`} className={styles.tile}>
                <div className={styles.head}>
                  <span className={styles.name}>{name}</span>
                  {system && system !== name && <span className={styles.system}>{system}</span>}
                </div>
                <span className={styles.count}>
                  {loc.count} {loc.count === 1 ? 'stack' : 'stacks'}
                </span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p>
          No assets visible. Link a character with the <code>esi-assets.read_assets.v1</code> scope on the{' '}
          <a href="/character">Characters</a> page so the hourly job can fetch them.
        </p>
      )}
    </>
  )
}
export default AssetsPage
