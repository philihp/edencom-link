// Reading a subject's blueprint originals and dressing them with SDE names.
//
// Two subjects, one shape: an account's characters (character_blueprint, scoped
// to the registrations resolveBposAccount() found) or a corporation's hangars
// (corp_blueprint, scoped to the one corporation id). Service-role in both
// cases — the /corpses precedent — because the caller has already decided the
// viewer may see them.
import { forEach, map } from 'ramda'

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
  forEach((row: BlueprintRow) => acc.push(row), rows)
  return rows.length < PAGE_SIZE ? acc : readBlueprints(registrationIds, from + PAGE_SIZE, acc)
}

// The corporation's own hangars. Same columns, same original filter; the corp
// mirror is refreshed daily (the character one every 6h), which is the only
// difference a visitor could notice. Ordered by item_id as well as type_id so
// the range paging has a unique tiebreaker — corp collections are the large
// ones, and a page boundary landing inside a run of identical type_ids would
// otherwise be able to repeat or skip a row.
const readCorpBlueprints = async (
  corporationId: number,
  from = 0,
  acc: BlueprintRow[] = []
): Promise<BlueprintRow[]> => {
  const { data, error } = await createServiceClient()
    .from('corp_blueprint')
    .select('type_id, material_efficiency, time_efficiency, quantity, runs')
    .eq('corporation_id', corporationId)
    .eq('runs', -1)
    .order('type_id')
    .order('item_id')
    .range(from, from + PAGE_SIZE - 1)
    .returns<BlueprintRow[]>()
  if (error) {
    console.error(`[bpos] corp blueprint read failed: ${error.message}`)
    return acc
  }
  const rows = data ?? []
  forEach((row: BlueprintRow) => acc.push(row), rows)
  return rows.length < PAGE_SIZE ? acc : readCorpBlueprints(corporationId, from + PAGE_SIZE, acc)
}

// Stack the rows, then resolve the two SDE hops the table renders. Shared by
// both subjects: the row shape is identical, so only the read above differs.
const dressStacks = async (rows: BlueprintRow[]): Promise<BpoEntry[]> => {
  const stacks = stackBpos(rows)
  if (stacks.length === 0) return []

  const blueprintTypeIds = map((s) => s.typeId, stacks)

  // Two SDE hops: the blueprint's own name, and — via what it manufactures —
  // the category worth sorting by. A blueprint type's own category is always
  // "Blueprint", which tells a visitor nothing.
  const [blueprintTypes, products] = await Promise.all([
    getSdeTypes(blueprintTypeIds),
    getBlueprintsByTypeIDs(blueprintTypeIds),
  ])
  const productTypes = await getSdeTypes(map((b) => b.productTypeID, Object.values(products)))

  return map((stack) => {
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
  }, stacks)
}

export const fetchBpoEntries = async (registrationIds: string[]): Promise<BpoEntry[]> =>
  registrationIds.length === 0 ? [] : dressStacks(await readBlueprints(registrationIds))

export const fetchCorpBpoEntries = async (corporationId: number): Promise<BpoEntry[]> =>
  dressStacks(await readCorpBlueprints(corporationId))
