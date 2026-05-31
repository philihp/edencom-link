import { universeStructure } from './esi.js'
import { sudoSupabase } from './supabase.js'
import { refreshAccessToken } from './tokenRefresh.js'

const UNIVERSE_STRUCTURES_SCOPE = 'esi-universe.read_structures.v1'

// Player Upwell structures use ids in this range; NPC stations (≤64M) and solar
// systems sit far below it, and an item id in this range that's also one of the
// character's own items is a ship/container, not a structure.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// Resolve and cache (in hangar.structure) the names/systems of the player
// structures characters hold assets in, using each character's own token so
// docking access is guaranteed. Cheap in steady state: candidates exclude
// structures we already know (our corp's, plus anything resolved before).
export const resolveStructureNames = async () => {
  const { data: tokens, error } = await sudoSupabase
    .schema('hangar')
    .from('token')
    .select('id, character_id, refresh_token')
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

  let upserted = 0
  for (const tokenRow of tokens) {
    try {
      const { access_token, scope } = await refreshAccessToken(tokenRow)
      if (!scope.includes(UNIVERSE_STRUCTURES_SCOPE)) continue

      // Candidate structures = root locations in this character's assets that sit in
      // the player-structure id range and aren't one of the character's own items.
      // Read asset_over_time (the base table service_role can reach) filtered to the
      // live rows, rather than the `asset` view, which is only granted to authenticated.
      const { data: assets, error: assetsErr } = await sudoSupabase
        .schema('hangar')
        .from('asset_over_time')
        .select('item_id, location_id')
        .eq('character_id', tokenRow.character_id)
        .eq('is_current', true)
      if (assetsErr) throw assetsErr
      const itemIds = new Set((assets ?? []).map((a) => Number(a.item_id)))
      const candidates = new Set()
      for (const a of assets ?? []) {
        const id = Number(a.location_id)
        if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR && !itemIds.has(id) && !resolved.has(id)) {
          candidates.add(id)
        }
      }
      if (candidates.size === 0) continue

      for (const structureID of candidates) {
        try {
          const info = await universeStructure(access_token, structureID)
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
          if (upErr) throw upErr
          resolved.add(structureID)
          upserted += 1
        } catch (e) {
          // 403 = this character can't dock there (e.g. access since revoked); another
          // character with access may still resolve it on a later pass, so don't cache.
          console.warn(`[structures] structure ${structureID} via token ${tokenRow.id} failed: ${e?.message}`)
        }
      }
    } catch (e) {
      console.error(`[structures] structure-name token ${tokenRow.id} FAILED: ${e?.message}`)
    }
  }
  console.log(`[structures] resolved ${upserted} player structure name(s)`)
}
