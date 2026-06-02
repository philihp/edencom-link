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
  name: string | null
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

  // Root-level assets at this location: ships, containers and loose stacks that
  // sit directly in the station/structure/system (not nested in another item).
  // Only this level is fetched — the whole asset table no longer pages into Node.
  const { data: children } = await supabase
    .from('asset')
    .select('item_id, character_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, name')
    .eq('location_id', locationId)
  const rootItems = (children ?? []) as Asset[]

  // Total items held inside each ship/container at this location, counted across
  // the whole subtree by asset_location_contents() in Postgres.
  const { data: contentsRows } = await supabase.rpc('asset_location_contents', { parent: locationId })
  const contentsByItem = new Map<string, number>(
    ((contentsRows ?? []) as { item_id: number | string; contents: number | string }[]).map((r) => [
      String(r.item_id),
      Number(r.contents),
    ]),
  )

  // The id is either a place (station / structure / solar system) or one of our
  // own items — a ship or container the user drilled into. Resolve the heading
  // and the "back" target accordingly.
  const { data: self } = await supabase
    .from('asset')
    .select('item_id, type_id, location_id, name')
    .eq('item_id', locationId)
    .maybeSingle<Pick<Asset, 'item_id' | 'type_id' | 'location_id' | 'name'>>()

  let heading: string
  let backHref = '/assets'
  let backLabel = 'Back to Assets'
  let systemName: string | undefined

  if (self) {
    // A ship/container: title it by its custom name (if any) plus type, and step
    // back to whatever holds it.
    const typeNames = await fetchTypeNames([Number(self.type_id)])
    const typeName = typeNames[Number(self.type_id)] ?? `#${self.type_id}`
    heading = self.name && self.name !== typeName ? `${self.name} (${typeName})` : typeName
    if (self.location_id != null) {
      backHref = `/assets/${self.location_id}`
      backLabel = 'Back'
    }
  } else {
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

    heading =
      (structure
        ? (structure.name ?? `Structure #${locationId}`)
        : (stationNames[numericId] ?? (locationType === 'solar_system' ? systemNames[numericId] : undefined))) ??
      `Location #${locationId}`
    systemName = systemId != null ? (systemNames[systemId] ?? `#${systemId}`) : undefined
  }

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
      name: a.name,
      quantity: a.quantity,
      isSingleton: a.is_singleton,
      flag: a.location_flag,
      contents: contentsByItem.get(String(a.item_id)) ?? 0,
    }))
    .sort((a, b) => b.contents - a.contents || a.typeId - b.typeId)

  return (
    <>
      <h1 className="serif">{heading}</h1>
      {systemName && systemName !== heading ? (
        <p>
          System: <span className="serif">{systemName}</span>
        </p>
      ) : null}
      <p>
        <Link href={backHref}>&laquo; {backLabel}</Link>
      </p>

      <LocationAssets rows={rows} characters={sortedCharacters} typeNamesPromise={typeNamesPromise} />
    </>
  )
}
export default AssetLocationPage
