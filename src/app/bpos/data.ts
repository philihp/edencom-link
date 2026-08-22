// Reading one account's blueprint originals and dressing them with SDE names.
//
// Service-role, explicitly scoped to the registrations resolveBposAccount()
// found — the /corpses precedent. The caller has already decided the viewer may
// see them.
import { getBlueprintsByTypeIDs } from '@/sdeBlueprints'
import { getSdeTypes } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { stackBpos, type BlueprintRow, type BpoEntry } from './stack'

// PostgREST caps a response at 1000 rows and a prolific industrialist owns more
// blueprints than that, so the read is range-paged rather than trusting one
// request to be complete — a truncated page would silently under-report the
// collection the page exists to show off.
const PAGE_SIZE = 1000

const readBlueprints = async (
  registrationIds: string[],
  from = 0,
  acc: BlueprintRow[] = []
): Promise<BlueprintRow[]> => {
  const { data, error } = await createServiceClient()
    .from('character_blueprint')
    .select('type_id, material_efficiency, time_efficiency, quantity, runs')
    .in('registration_id', registrationIds)
    // ESI marks an original with runs = -1; pushing the filter down keeps
    // copies out of the response entirely (stackBpos re-checks anyway).
    .eq('runs', -1)
    .order('type_id')
    .range(from, from + PAGE_SIZE - 1)
    .returns<BlueprintRow[]>()
  if (error) {
    console.error(`[bpos] blueprint read failed: ${error.message}`)
    return acc
  }
  const rows = data ?? []
  rows.forEach((row) => acc.push(row))
  return rows.length < PAGE_SIZE ? acc : readBlueprints(registrationIds, from + PAGE_SIZE, acc)
}

export const fetchBpoEntries = async (registrationIds: string[]): Promise<BpoEntry[]> => {
  if (registrationIds.length === 0) return []

  const stacks = stackBpos(await readBlueprints(registrationIds))
  if (stacks.length === 0) return []

  const blueprintTypeIds = stacks.map((s) => s.typeId)

  // Two SDE hops: the blueprint's own name, and — via what it manufactures —
  // the category worth sorting by. A blueprint type's own category is always
  // "Blueprint", which tells a visitor nothing.
  const [blueprintTypes, products] = await Promise.all([
    getSdeTypes(blueprintTypeIds),
    getBlueprintsByTypeIDs(blueprintTypeIds),
  ])
  const productTypes = await getSdeTypes(Object.values(products).map((b) => b.productTypeID))

  return stacks.map((stack) => {
    const product = products[stack.typeId]
    const productType = product ? productTypes[product.productTypeID] : undefined
    return {
      ...stack,
      name: blueprintTypes[stack.typeId]?.name ?? null,
      // Fall back to the blueprint's own group ("Frigate Blueprint" and the
      // like) when nothing in the mirror says what it builds, so a row still
      // lands in a sensible bucket rather than under "Uncategorized".
      category: productType?.categoryName ?? blueprintTypes[stack.typeId]?.groupName ?? null,
    }
  })
}
