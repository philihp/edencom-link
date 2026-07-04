import { createShuffle } from 'fast-shuffle'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { prop, uniqBy } from 'ramda'

import { searchSdeTypesAll } from '@/sdeTypes'
import { createClient } from '@/utils/supabase/server'

import { fetchOwners } from '../../owners'
import { resolveLocations, type LocationRef } from '../../resolveLocations'
import retro from '../../retro.module.css'
import { TypeName } from '../../typeName'
import { AssetSearchForm } from '../assetSearchForm'
import { Quantity } from '../[locationId]/quantity'

// Above this, the substring is too broad to be a useful item filter (and the
// search functions below would end up walking a large chunk of the hangar).
const MAX_TYPES = 100

// Fixed seed so the "too many types" preview shuffle is reproducible across
// requests rather than changing every page load. createShuffle's returned
// shuffler carries internal state across calls, so a fresh one is created per
// request rather than reused from module scope.
const SHUFFLE_SEED = 20260704

type CharacterSearchRow = {
  item_id: number | string
  character_id: string
  type_id: number | string
  quantity: number | string | null
  is_singleton: boolean | null
  name: string | null
  location_flag: string | null
  root_location_id: number | string | null
  root_location_type: string | null
  contents: number | string
}

// Corp assets carry no player-assigned name column; owner is the corporation.
type CorpSearchRow = Omit<CharacterSearchRow, 'character_id' | 'name'> & { corporation_id: number | string }

type SearchRow = {
  itemId: string
  ownerId: string
  typeId: number
  name: string | null
  quantity: number | string | null
  isSingleton: boolean | null
  flag: string | null
  root: LocationRef | null
  contents: number
}

const AssetSearchPage = async ({ searchParams }: { searchParams: Promise<{ q?: string }> }) => {
  const { q } = await searchParams
  const query = (q ?? '').trim()

  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth?.user) {
    redirect('/')
  }

  if (!query) {
    return (
      <>
        <h1>Search Assets</h1>
        <p>Enter part of an item name to find every stack of it across your hangars.</p>
        <AssetSearchForm />
      </>
    )
  }

  // Case-insensitive substring match against every published type name, resolved
  // from the locally generated SDE data (never the stale evesde DB schema).
  const matches = searchSdeTypesAll(query)

  if (matches.length > MAX_TYPES) {
    const sample = createShuffle(SHUFFLE_SEED)(matches)
      .slice(0, 10)
      .sort((a, b) => a.name.localeCompare(b.name))
    return (
      <>
        <h1>Search Assets</h1>
        <p>
          &quot;{query}&quot; matched {matches.length} item types — that&apos;s too many to search at once. Try a more
          specific term.
        </p>
        <p>A sample of what matched:</p>
        <ul>
          {sample.map((m) => (
            <li key={m.typeID}>{m.name}</li>
          ))}
        </ul>
        <AssetSearchForm initialQuery={query} />
      </>
    )
  }

  if (matches.length === 0) {
    return (
      <>
        <h1>Search Assets</h1>
        <p>No item types matched &quot;{query}&quot;.</p>
        <AssetSearchForm initialQuery={query} />
      </>
    )
  }

  const typeIds = matches.map((m) => m.typeID)
  const typeNameById = new Map(matches.map((m) => [m.typeID, m.name]))
  // Pre-resolved (not streamed) since the search results above already carry
  // every matched type's name — no extra SDE lookup needed. TypeName still
  // expects a promise (it also renders each row's player-assigned name, if any).
  const typeNamesPromise = Promise.resolve(Object.fromEntries(typeNameById))

  const [{ data: characterRows }, { data: corpRows }, owners] = await Promise.all([
    supabase.rpc('character_asset_search', { type_ids: typeIds }),
    supabase.rpc('corp_asset_search', { type_ids: typeIds }),
    fetchOwners(),
  ])

  const rows: SearchRow[] = [
    ...((characterRows ?? []) as CharacterSearchRow[]).map((r): SearchRow => ({
      itemId: String(r.item_id),
      ownerId: r.character_id,
      typeId: Number(r.type_id),
      name: r.name,
      quantity: r.quantity,
      isSingleton: r.is_singleton,
      flag: r.location_flag,
      root: r.root_location_id != null ? { id: String(r.root_location_id), type: r.root_location_type } : null,
      contents: Number(r.contents),
    })),
    ...((corpRows ?? []) as CorpSearchRow[]).map((r): SearchRow => ({
      itemId: String(r.item_id),
      ownerId: String(r.corporation_id),
      typeId: Number(r.type_id),
      name: null,
      quantity: r.quantity,
      isSingleton: r.is_singleton,
      flag: r.location_flag,
      root: r.root_location_id != null ? { id: String(r.root_location_id), type: r.root_location_type } : null,
      contents: Number(r.contents),
    })),
  ]

  const rootRefs = uniqBy(
    prop('id'),
    rows.map((r) => r.root).filter((r): r is LocationRef => r != null)
  )
  const { nameFor, systemFor } = await resolveLocations(rootRefs)
  const ownerMap = new Map([...owners.characters, ...owners.corporations].map((o) => [o.id, o.name]))

  const displayRows = rows
    .map((row) => {
      // A root is either a station/structure (has its own name, distinct from
      // the system it's in) or a bare solar system (the item is floating —
      // there's no separate "station" to show).
      const floating = row.root?.type === 'solar_system'
      const stationName = row.root && !floating ? nameFor(row.root) : null
      const systemName = row.root ? (systemFor(row.root) ?? (floating ? nameFor(row.root) : null)) : null
      return { row, stationName, systemName, floating }
    })
    // Group by system, then station, then item name for a stable, browsable order.
    .sort(
      (a, b) =>
        (a.systemName ?? '').localeCompare(b.systemName ?? '') ||
        (a.stationName ?? '').localeCompare(b.stationName ?? '') ||
        (typeNameById.get(a.row.typeId) ?? '').localeCompare(typeNameById.get(b.row.typeId) ?? '')
    )

  return (
    <>
      <h1>Search Assets</h1>
      <p>
        {displayRows.length} item{displayRows.length === 1 ? '' : 's'} matching &quot;{query}&quot; across{' '}
        {typeIds.length} item type{typeIds.length === 1 ? '' : 's'}.
      </p>
      {displayRows.length > 0 ? (
        <table className={retro.retro}>
          <thead>
            <tr>
              <th>Owner</th>
              <th>System</th>
              <th>Station</th>
              <th>Item</th>
              <th className={retro.num}>Quantity</th>
              <th>Hangar</th>
              <th className={retro.num}>Contents</th>
            </tr>
          </thead>
          <tbody>
            {displayRows.map(({ row, stationName, systemName, floating }) => (
              <tr key={`${row.ownerId}-${row.itemId}`}>
                <td>{ownerMap.get(row.ownerId) ?? row.ownerId}</td>
                <td className="serif">
                  {row.root && floating ? (
                    <Link href={`/asset/${row.root.id}`}>{systemName}</Link>
                  ) : (
                    (systemName ?? '—')
                  )}
                </td>
                <td className="serif">
                  {row.root && !floating ? <Link href={`/asset/${row.root.id}`}>{stationName}</Link> : '—'}
                </td>
                <td>
                  {row.contents > 0 ? (
                    <Link href={`/asset/${row.itemId}`}>
                      <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                    </Link>
                  ) : (
                    <TypeName id={row.typeId} name={row.name} promise={typeNamesPromise} />
                  )}
                </td>
                <td className={retro.num}>{row.isSingleton ? '—' : <Quantity value={row.quantity} />}</td>
                <td>{row.flag ?? '—'}</td>
                <td className={retro.num}>{row.contents > 0 ? row.contents : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p>No assets found for those item types.</p>
      )}
      <AssetSearchForm initialQuery={query} />
    </>
  )
}

export default AssetSearchPage
