// DB-backed lookup over the nightly SDE mirror (the sde_blueprint_product
// materialized view — see supabase/migrations/20260716010000_sde_mirror.sql).
// Covers manufacturing and reaction blueprints — the "consume materials →
// produce output" activities — so the app can answer "how do I build X" and
// "what consumes X" without the old build-time JSON. Low-volume paths (the two
// MCP blueprint tools and the blueprint pages), so these aren't cached.
//
// Fourth loader migrated in the SDE-loaders-to-database cutover
// (docs/sde-db-cutover/01-loader-cutover.md).
import { splitEvery } from 'ramda'

import { sdeSupabase } from './utils/supabase/sde'

// EVE industry activity ids present in the mirror's blueprint-product view.
export const MANUFACTURING = 1
export const REACTION = 11

export type BlueprintMaterial = { typeID: number; quantity: number }
export type Blueprint = {
  blueprintTypeID: number
  activityID: number
  productTypeID: number
  productQuantity: number
  materials: BlueprintMaterial[]
}

type BlueprintRow = {
  blueprint_type_id: number
  activity_id: number
  product_type_id: number
  product_quantity: number
  // CCP's raw [{ typeID, quantity }, …] array, carried through the view as jsonb.
  materials: Array<{ typeID?: number; quantity?: number }> | null
}

const rowToBlueprint = (r: BlueprintRow): Blueprint => ({
  blueprintTypeID: r.blueprint_type_id,
  activityID: r.activity_id,
  productTypeID: r.product_type_id,
  productQuantity: r.product_quantity,
  // Map defensively and sort by type id to preserve the old deterministic order.
  materials: (r.materials ?? [])
    .map((m) => ({ typeID: Number(m.typeID), quantity: Number(m.quantity) }))
    .sort((a, b) => a.typeID - b.typeID),
})

// The blueprint that produces the given product. Manufacturing is preferred
// over a reaction when a product is somehow made by both, and lower blueprint
// type id breaks any remaining tie — so the choice is stable across builds.
export const getBlueprintForProduct = async (productTypeID: number): Promise<Blueprint | null> => {
  const { data, error } = await sdeSupabase()
    .from('sde_blueprint_product')
    .select('blueprint_type_id, activity_id, product_type_id, product_quantity, materials')
    .eq('product_type_id', productTypeID)
  if (error) {
    console.error(`[sdeBlueprints] product lookup failed: ${error.message}`)
    return null
  }
  const candidates = (data ?? []) as BlueprintRow[]
  if (candidates.length === 0) return null
  return candidates
    .map(rowToBlueprint)
    .sort(
      (a, b) =>
        Number(b.activityID === MANUFACTURING) - Number(a.activityID === MANUFACTURING) ||
        a.blueprintTypeID - b.blueprintTypeID
    )[0]
}

// Every blueprint that consumes the given type as an input material, ordered
// by product type id for a stable, browsable result. The GIN jsonb_path_ops
// index on materials serves this @> containment probe.
export const getBlueprintsForMaterial = async (materialTypeID: number): Promise<Blueprint[]> => {
  const { data, error } = await sdeSupabase()
    .from('sde_blueprint_product')
    .select('blueprint_type_id, activity_id, product_type_id, product_quantity, materials')
    .contains('materials', [{ typeID: materialTypeID }])
  if (error) {
    console.error(`[sdeBlueprints] material lookup failed: ${error.message}`)
    return []
  }
  return ((data ?? []) as BlueprintRow[]).map(rowToBlueprint).sort((a, b) => a.productTypeID - b.productTypeID)
}

// The reverse of getBlueprintForProduct, in bulk: what each of these blueprint
// types makes. The BPO showcase (/bpos/[name]) needs it to label a blueprint
// with its PRODUCT's category — every blueprint type is itself in category
// "Blueprint", which would sort a whole collection into one bucket.
//
// Uncached like its siblings, and chunked at 500 ids so a large collection
// stays under PostgREST's 1000-row response cap. Manufacturing wins over a
// reaction, then the lower blueprint type id, exactly as the by-product lookup
// resolves its ties.
export const getBlueprintsByTypeIDs = async (
  blueprintTypeIDs: Iterable<number>
): Promise<Record<number, Blueprint>> => {
  const ids = [...new Set(blueprintTypeIDs)].filter((id) => Number.isFinite(id))
  if (ids.length === 0) return {}

  const chunks = await Promise.all(
    splitEvery(500, ids).map(async (chunk) => {
      const { data, error } = await sdeSupabase()
        .from('sde_blueprint_product')
        .select('blueprint_type_id, activity_id, product_type_id, product_quantity, materials')
        .in('blueprint_type_id', chunk)
      if (error) {
        console.error(`[sdeBlueprints] blueprint lookup failed: ${error.message}`)
        return [] as BlueprintRow[]
      }
      return (data ?? []) as BlueprintRow[]
    })
  )

  return chunks.flat().reduce<Record<number, Blueprint>>((acc, row) => {
    const blueprint = rowToBlueprint(row)
    const seen = acc[blueprint.blueprintTypeID]
    const better =
      seen == null ||
      Number(blueprint.activityID === MANUFACTURING) - Number(seen.activityID === MANUFACTURING) > 0 ||
      (blueprint.activityID === seen.activityID && blueprint.productTypeID < seen.productTypeID)
    if (better) acc[blueprint.blueprintTypeID] = blueprint
    return acc
  }, {})
}
