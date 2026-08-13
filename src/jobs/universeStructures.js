import { forEach, map, pipe, prop, reject } from 'ramda'

import { universeStructure } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'universe-structures'
const SCOPE = 'esi-universe.read_structures.v1'

// Player Upwell structures use ids in this range; NPC stations (≤64M) and solar
// systems sit far below it, and an item id in this range that's also one of the
// characters' own items is a ship/container, not a structure.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// PostgREST caps a single select; page through the source tables so a large
// hangar doesn't silently truncate the candidate/own-item sets.
const ASSET_PAGE = 1000

// Every table we already extract that records *where* something was, and the
// columns holding that location. A structure id in any of them is proof one of
// our characters has been there, which makes it worth a name — and it costs no
// ESI calls to harvest, since the rows are already in Postgres
// (docs/structure-universe/design.md).
//
// `orderBy` is the table's primary key (or its first component): range paging
// without an explicit sort is unstable in PostgREST and can skip or repeat rows
// across pages, silently dropping a structure from the candidate set.
// `current` marks the SCD-2 tables, whose live snapshot is is_current rows.
//
// Contracts are the quiet win here: a courier contract's start/end locations
// are often the only record of a structure a character docks at but keeps
// nothing in.
const LOCATION_SOURCES = [
  { table: 'character_asset_over_time', columns: ['location_id'], orderBy: 'id', current: true },
  { table: 'corp_asset_over_time', columns: ['location_id'], orderBy: 'id', current: true },
  { table: 'character_order_over_time', columns: ['location_id'], orderBy: 'id', current: true },
  {
    table: 'character_industry_job_over_time',
    columns: ['facility_id', 'station_id', 'blueprint_location_id', 'output_location_id'],
    orderBy: 'id',
    current: true,
  },
  {
    table: 'corp_industry_job_over_time',
    columns: ['facility_id', 'station_id', 'blueprint_location_id', 'output_location_id'],
    orderBy: 'id',
    current: true,
  },
  {
    table: 'character_contract',
    columns: ['start_location_id', 'end_location_id'],
    orderBy: 'contract_id',
    current: false,
  },
  { table: 'corp_contract', columns: ['start_location_id', 'end_location_id'], orderBy: 'contract_id', current: false },
  { table: 'character_wallet_transaction', columns: ['location_id'], orderBy: 'transaction_id', current: false },
  { table: 'corp_wallet_transaction', columns: ['location_id'], orderBy: 'transaction_id', current: false },
]

// One source table's location columns, drained past the PostgREST row cap by
// recursing to the next page until a short page signals the end.
const fetchLocationRows = async ({ table, columns, orderBy, current }, from = 0, acc = []) => {
  let query = sudoSupabase.from(table).select(columns.join(', '))
  if (current) query = query.eq('is_current', true)
  const { data: rows, error } = await query.order(orderBy, { ascending: true }).range(from, from + ASSET_PAGE - 1)
  if (error) throw new Error(`reading ${table} failed: ${error.message}`)
  const page = rows ?? []
  forEach((row) => acc.push(row), page)
  if (page.length < ASSET_PAGE) return acc
  return fetchLocationRows({ table, columns, orderBy, current }, from + ASSET_PAGE, acc)
}

// The item ids of everything our characters own. A location in the structure id
// range that's also one of these is a ship or container, not a structure.
const fetchOwnedItemIds = async (from = 0, acc = []) => {
  const { data: rows, error } = await sudoSupabase
    .from('character_asset_over_time')
    .select('item_id')
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + ASSET_PAGE - 1)
  if (error) throw error
  const page = rows ?? []
  forEach((row) => acc.push(Number(row.item_id)), page)
  if (page.length < ASSET_PAGE) return acc
  return fetchOwnedItemIds(from + ASSET_PAGE, acc)
}

// GET /universe/structures/{id} → universe_structure. Resolves and caches the
// names/systems of the player structures characters hold assets or clones in.
// Candidates are pooled across *all* linked characters and each is attempted against
// *every* scoped token until one can dock and resolve it — a structure only
// needs a single character with docking access, and that character is often not
// the one whose assets sit there. Cheap in steady state: candidates exclude
// structures we already know (our corp's, plus anything resolved before).
// Account-wide by construction, so it takes no character scope.
export const runUniverseStructures = async () => {
  const { data: tokens, error } = await sudoSupabase
    .from('token')
    .select('id, registration_id, refresh_token')
    .contains('scope', [SCOPE])
  if (error) throw error

  console.log(`[${TAG}] ${tokens?.length ?? 0} token(s) with ${SCOPE}`)
  if (!tokens || tokens.length === 0) return

  // Ids we don't need to resolve: our own corp structures and anything already
  // *named*. Rows without a name don't count as resolved — the hourly
  // structure-directory job seeds ids straight from ESI's public list with
  // nothing to call them, and treating those as done would mean nothing ever
  // put a name on them.
  const { data: corpStructs } = await sudoSupabase.from('corp_structure').select('structure_id')
  const { data: knownStructs } = await sudoSupabase
    .from('universe_structure')
    .select('structure_id')
    .not('name', 'is', null)
  const resolved = new Set(map(pipe(prop('structure_id'), Number), [...(corpStructs ?? []), ...(knownStructs ?? [])]))

  // Pool candidate structure ids from every location column we already extract
  // (LOCATION_SOURCES). itemIds is the union of all owned item ids across
  // characters: a location in the structure range that's also someone's item is
  // a ship/container, not a structure. Read the *_over_time base tables (what
  // service_role can reach) filtered to live rows, rather than the views
  // (granted to authenticated).
  const itemIds = new Set(await fetchOwnedItemIds())
  const locationIds = new Set()
  await forEachSequential(LOCATION_SOURCES, async (source) => {
    const before = locationIds.size
    forEach(
      (row) =>
        forEach((column) => {
          const id = Number(row[column])
          if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR) locationIds.add(id)
        }, source.columns),
      await fetchLocationRows(source)
    )
    console.log(`[${TAG}] ${source.table}: ${locationIds.size - before} new candidate id(s)`)
  })

  // Clones parked in player structures are candidates too — the character-clones
  // job resolves what it can with each clone's own token, but only a character
  // with docking access can resolve a given structure, and that's often a
  // different character than the clone's owner.
  const { data: cloneRows, error: clonesErr } = await sudoSupabase
    .from('character_clone_over_time')
    .select('location_id')
    .eq('is_current', true)
    .eq('location_type', 'structure')
  if (clonesErr) throw clonesErr
  forEach((r) => {
    const id = Number(r.location_id)
    if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR) locationIds.add(id)
  }, cloneRows ?? [])

  const candidates = reject((id) => itemIds.has(id) || resolved.has(id), [...locationIds])
  console.log(`[${TAG}] ${candidates.length} candidate player structure(s) to resolve`)
  if (candidates.length === 0) return

  // Refresh each token's access token at most once and remember the result, so
  // attempting many candidates against many tokens doesn't re-refresh. null means
  // the token couldn't be refreshed or no longer carries the scope.
  const accessByToken = new Map()
  const getAccess = async (tokenRow) => {
    if (accessByToken.has(tokenRow.id)) return accessByToken.get(tokenRow.id)
    let access = null
    try {
      const { access_token, scope } = await refreshAccessToken(tokenRow)
      if (scope.includes(SCOPE)) access = access_token
    } catch (e) {
      console.error(`[${TAG}] token ${tokenRow.id} refresh FAILED: ${e?.message}`)
    }
    accessByToken.set(tokenRow.id, access)
    return access
  }

  // Try resolving `structureID` against tokens in order, stopping at the first
  // one that succeeds. `lastError` carries the most recent failure forward so a
  // structure nobody can resolve still reports why.
  const resolveAgainstTokens = async (structureID, remainingTokens, lastError) => {
    if (remainingTokens.length === 0) return { info: null, lastError }
    const [tokenRow, ...rest] = remainingTokens
    const access = await getAccess(tokenRow)
    if (!access) return resolveAgainstTokens(structureID, rest, lastError)
    try {
      const info = await universeStructure(access, structureID)
      return { info, lastError }
    } catch (e) {
      // Usually 403 = this character can't dock here; another linked character
      // might, so try the next token before giving up on this structure.
      return resolveAgainstTokens(structureID, rest, e)
    }
  }

  let upserted = 0
  await forEachSequential(candidates, async (structureID) => {
    const { info, lastError } = await resolveAgainstTokens(structureID, tokens, undefined)
    if (!info) {
      // No linked character can resolve it (e.g. nobody has docking access). Don't
      // cache — a later pass may succeed if access is granted.
      console.warn(
        `[${TAG}] structure ${structureID} unresolved by any token: ${lastError?.message ?? 'no scoped token'}`
      )
      return
    }
    const { error: upErr } = await sudoSupabase.from('universe_structure').upsert(
      {
        structure_id: structureID,
        name: info?.name ?? null,
        system_id: info?.solar_system_id ?? null,
        type_id: info?.type_id ?? null,
        owner_corporation_id: info?.owner_id ?? null,
        // Outranks 'everef' and 'public-list', so the hourly directory job
        // never overwrites a name we resolved with real docking access — this
        // is the only source that can name a *private* structure.
        source: 'esi-token',
        resolved_at: new Date().toISOString(),
      },
      { onConflict: 'structure_id' }
    )
    if (upErr) {
      console.warn(`[${TAG}] structure ${structureID} upsert failed: ${upErr.message}`)
      return
    }
    resolved.add(structureID)
    upserted += 1
  })
  console.log(`[${TAG}] resolved ${upserted} player structure name(s)`)
}

cli(import.meta.url, TAG, runUniverseStructures)
