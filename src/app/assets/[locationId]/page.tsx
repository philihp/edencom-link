import Link from 'next/link'
import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'
import { fetchStationNames, fetchStationSystems } from '../../stationNames'
import { fetchSystemNames } from '../../systemNames'
import { fetchTypeNames } from '../../typeNames'
import { LocationAssets, type ItemRow } from './locationAssets'

// Bigint ids arrive from PostgREST as strings; keep them as strings and only
// convert at the API/system-lookup boundary (mirrors the assets index page).
type Asset = {
  item_id: number | string
  character_id: string
  type_id: number | string
  location_id: number | string | null
  location_flag: string | null
  location_type: string | null
  quantity: number | string | null
  is_singleton: boolean | null
}

type Structure = {
  structure_id: number | string
  name: string | null
  system_id: number | string | null
}

const AssetLocationPage = async ({ params }: { params: Promise<{ locationId: string }> }) => {
  const { locationId } = await params
  const supabase = await createClient()

  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  // Page through every current asset (PostgREST caps a select at the API "Max
  // rows" limit) so the parent→child map is complete: contents counts walk it.
  const PAGE = 1000
  const list: Asset[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('asset')
      .select('item_id, character_id, type_id, location_id, location_flag, location_type, quantity, is_singleton')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error || !data || data.length === 0) break
    list.push(...(data as Asset[]))
    if (data.length < PAGE) break
  }

  // Items grouped by the container/location they sit directly in.
  const childrenByParent = new Map<string, Asset[]>()
  for (const a of list) {
    if (a.location_id == null) continue
    const key = String(a.location_id)
    const siblings = childrenByParent.get(key)
    if (siblings) siblings.push(a)
    else childrenByParent.set(key, [a])
  }

  // Root-level assets at this location: ships, containers and loose stacks that
  // sit directly in the station/structure/system (not nested in another item).
  const rootItems = childrenByParent.get(locationId) ?? []

  // Total items held inside a ship/container, walking the whole subtree.
  const contentsCount = (itemId: string, seen = new Set<string>()): number => {
    if (seen.has(itemId)) return 0
    seen.add(itemId)
    const kids = childrenByParent.get(itemId) ?? []
    return kids.reduce((n, k) => n + 1 + contentsCount(String(k.item_id), seen), 0)
  }

  // Resolve the location's own name/system the same way the index page does:
  // own-corp + foreign player structures from the DB, NPC stations and systems
  // from eve-build-calculator.
  const numericId = Number(locationId)
  const { data: corpStructures } = await supabase
    .from('corp_structure')
    .select('structure_id, name, system_id')
    .eq('structure_id', numericId)
  const { data: playerStructures } = await supabase
    .from('structure')
    .select('structure_id, name, system_id')
    .eq('structure_id', numericId)
  const structure = ((corpStructures?.[0] ?? playerStructures?.[0]) ?? null) as Structure | null

  const locationType = rootItems[0]?.location_type ?? null
  const [stationNames, stationSystems] = await Promise.all([
    fetchStationNames([numericId]),
    fetchStationSystems([numericId]),
  ])

  const systemId = structure?.system_id != null ? Number(structure.system_id) : stationSystems[numericId]
  const systemNames = await fetchSystemNames(
    [systemId, locationType === 'solar_system' ? numericId : undefined].filter((n): n is number => n != null),
  )

  const locationName = structure
    ? (structure.name ?? `Structure #${locationId}`)
    : (stationNames[numericId] ?? (locationType === 'solar_system' ? systemNames[numericId] : undefined))
  const systemName = systemId != null ? (systemNames[systemId] ?? `#${systemId}`) : undefined

  const { data: characters } = await supabase.from('registration').select('id, name')
  const sortedCharacters = [...(characters ?? [])].sort((a, b) => a.name.localeCompare(b.name))

  // Resolve type names without blocking render: fire the lookup and let each
  // TypeName stream in (Suspense), falling back to #id. A big hangar can hold
  // hundreds of distinct types, and awaiting them all here times the page out.
  const typeNamesPromise = fetchTypeNames(rootItems.map((a) => Number(a.type_id)))

  // Containers/ships (those holding items) first, then a stable id order.
  const rows: ItemRow[] = rootItems
    .map((a) => ({
      itemId: String(a.item_id),
      characterId: a.character_id,
      typeId: Number(a.type_id),
      quantity: a.quantity,
      isSingleton: a.is_singleton,
      flag: a.location_flag,
      contents: contentsCount(String(a.item_id)),
    }))
    .sort((a, b) => b.contents - a.contents || a.typeId - b.typeId)

  return (
    <>
      <h1 className="serif">{locationName ?? `Location #${locationId}`}</h1>
      {systemName && systemName !== locationName ? (
        <p>
          System: <span className="serif">{systemName}</span>
        </p>
      ) : null}
      <p>
        <Link href="/assets">&laquo; Back to Assets</Link>
      </p>

      <LocationAssets rows={rows} characters={sortedCharacters} typeNamesPromise={typeNamesPromise} />
    </>
  )
}
export default AssetLocationPage
