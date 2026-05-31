import { universeStructure } from './esi.js'
import { sudoSupabase } from './supabase.js'
import { refreshAccessToken } from './tokenRefresh.js'

const UNIVERSE_STRUCTURES_SCOPE = 'esi-universe.read_structures.v1'

// Player Upwell structures use ids in this range; NPC stations (≤64M) and solar
// systems sit far below it, and an item id in this range that's also one of the
// characters' own items is a ship/container, not a structure.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// PostgREST caps a single select; page through asset_over_time so a large hangar
// doesn't silently truncate the candidate/own-item sets.
const ASSET_PAGE = 1000

// Resolve and cache (in hangar.structure) the names/systems of the player
// structures characters hold assets in. Candidates are pooled across *all*
// linked characters and each is attempted against *every* scoped token until one
// can dock and resolve it — a structure only needs a single character with
// docking access, and that character is often not the one whose assets sit there.
// Cheap in steady state: candidates exclude structures we already know (our
// corp's, plus anything resolved before).
export const resolveStructureNames = async () => {
  const { data: tokens, error } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, registration_id, refresh_token')
    .contains('scope', [UNIVERSE_STRUCTURES_SCOPE])
  if (error) throw error

  console.log(`[structures] structure names: ${tokens?.length ?? 0} token(s) with ${UNIVERSE_STRUCTURES_SCOPE}`)
  if (!tokens || tokens.length === 0) return

  // Ids we don't need to resolve: our own corp structures and anything already cached.
  const { data: corpStructs } = await sudoSupabase.schema('hangar').from('corp_structure').select('structure_id')
  const { data: knownStructs } = await sudoSupabase.schema('hangar').from('structure').select('structure_id')
  const resolved = new Set()
  for (const s of corpStructs ?? []) resolved.add(Number(s.structure_id))
  for (const s of knownStructs ?? []) resolved.add(Number(s.structure_id))

  // Pool candidate structure ids from every character's live assets. itemIds is
  // the union of all owned item ids across characters: a location in the
  // structure range that's also someone's item is a ship/container, not a
  // structure. Read asset_over_time (the base table service_role can reach)
  // filtered to live rows, rather than the `asset` view (granted to authenticated).
  const itemIds = new Set()
  const locationIds = new Set()
  for (let from = 0; ; from += ASSET_PAGE) {
    const { data: rows, error: assetsErr } = await sudoSupabase
      .schema('hangar')
      .from('asset_over_time')
      .select('item_id, location_id')
      .eq('is_current', true)
      .range(from, from + ASSET_PAGE - 1)
    if (assetsErr) throw assetsErr
    if (!rows || rows.length === 0) break
    for (const r of rows) {
      itemIds.add(Number(r.item_id))
      const id = Number(r.location_id)
      if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR) locationIds.add(id)
    }
    if (rows.length < ASSET_PAGE) break
  }
  const candidates = [...locationIds].filter((id) => !itemIds.has(id) && !resolved.has(id))
  console.log(`[structures] ${candidates.length} candidate player structure(s) to resolve`)
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
      if (scope.includes(UNIVERSE_STRUCTURES_SCOPE)) access = access_token
    } catch (e) {
      console.error(`[structures] structure-name token ${tokenRow.id} refresh FAILED: ${e?.message}`)
    }
    accessByToken.set(tokenRow.id, access)
    return access
  }

  let upserted = 0
  for (const structureID of candidates) {
    let info = null
    let lastError
    for (const tokenRow of tokens) {
      const access = await getAccess(tokenRow)
      if (!access) continue
      try {
        info = await universeStructure(access, structureID)
        break
      } catch (e) {
        // Usually 403 = this character can't dock here; another linked character
        // might, so try the next token before giving up on this structure.
        lastError = e
      }
    }
    if (!info) {
      // No linked character can resolve it (e.g. nobody has docking access). Don't
      // cache — a later pass may succeed if access is granted.
      console.warn(
        `[structures] structure ${structureID} unresolved by any token: ${lastError?.message ?? 'no scoped token'}`
      )
      continue
    }
    const { error: upErr } = await sudoSupabase
      .schema('hangar')
      .from('structure')
      .upsert(
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
      console.warn(`[structures] structure ${structureID} upsert failed: ${upErr.message}`)
      continue
    }
    resolved.add(structureID)
    upserted += 1
  }
  console.log(`[structures] resolved ${upserted} player structure name(s)`)
}
