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

// PostgREST caps a single select; page through character_asset_over_time so a
// large hangar doesn't silently truncate the candidate/own-item sets.
const ASSET_PAGE = 1000

// Order by the primary key so range paging is stable: PostgREST gives no row
// order without an explicit sort, so an unordered .range() can skip or repeat
// rows across pages and silently drop a structure from the candidate set. The
// assets extract pages the same table and orders by id for exactly this reason.
const fetchAssetLocationRows = async (from = 0) => {
  const { data: rows, error: assetsErr } = await sudoSupabase
    .from('character_asset_over_time')
    .select('item_id, location_id')
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + ASSET_PAGE - 1)
  if (assetsErr) throw assetsErr
  const page = rows ?? []
  if (page.length < ASSET_PAGE) return page
  return [...page, ...(await fetchAssetLocationRows(from + ASSET_PAGE))]
}

// GET /universe/structures/{id} → universe_structure. Resolves and caches the
// names/systems of the player structures characters hold assets in. Candidates
// are pooled across *all* linked characters and each is attempted against
// *every* scoped token until one can dock and resolve it — a structure only
// needs a single character with docking access, and that character is often not
// the one whose assets sit there. Cheap in steady state: candidates exclude
// structures we already know (our corp's, plus anything resolved before).
// Account-wide by construction, so it takes no character scope.
export const runUniverseStructures = async () => {
  const { data: tokens, error } = await sudoSupabase
    .from('token')
    .select('id, character_id, refresh_token')
    .contains('scope', [SCOPE])
  if (error) throw error

  console.log(`[${TAG}] ${tokens?.length ?? 0} token(s) with ${SCOPE}`)
  if (!tokens || tokens.length === 0) return

  // Ids we don't need to resolve: our own corp structures and anything already cached.
  const { data: corpStructs } = await sudoSupabase.from('corp_structure').select('structure_id')
  const { data: knownStructs } = await sudoSupabase.from('universe_structure').select('structure_id')
  const resolved = new Set(map(pipe(prop('structure_id'), Number), [...(corpStructs ?? []), ...(knownStructs ?? [])]))

  // Pool candidate structure ids from every character's live assets. itemIds is
  // the union of all owned item ids across characters: a location in the
  // structure range that's also someone's item is a ship/container, not a
  // structure. Read character_asset_over_time (the base table service_role can
  // reach) filtered to live rows, rather than the character_asset view (granted
  // to authenticated).
  const itemIds = new Set()
  const locationIds = new Set()
  forEach(
    (r) => {
      itemIds.add(Number(r.item_id))
      const id = Number(r.location_id)
      if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR) locationIds.add(id)
    },
    await fetchAssetLocationRows()
  )

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
