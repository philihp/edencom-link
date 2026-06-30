// Thin wrappers over the local SDE data (src/sdeTypes.ts, the same source as
// `typeNames.ts`), used to power blueprint search/lookup without touching the
// stale `evesde` schema.

import { getSdeType, searchSdeTypes, type SdeSearchResult } from '@/sdeTypes'

// Search the type index by name, returning only blueprints as `[typeID, name]`.
// A complete-word query ("Rifter Blueprint") ranks the blueprint first, so we
// try the `… Blueprint`-suffixed query first; for a partial term ("rif") the
// search wants whole words, so we fall back to the raw query and keep the
// blueprint-named hits. Matches the old `'<substring>' & 'Blueprint'` behavior.
export const searchBlueprints = async (query: string): Promise<[typeID: string, name: string][]> => {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const blueprintsOnly = (results: SdeSearchResult[]) => results.filter((r) => r.name.endsWith('Blueprint'))
  const precise = blueprintsOnly(searchSdeTypes(`${trimmed} Blueprint`))
  const results = precise.length > 0 ? precise : blueprintsOnly(searchSdeTypes(trimmed))
  return results.map((r) => [`${r.typeID}`, r.name])
}

export type TypeRecord = { name: string | null; groupID: number | null; categoryID: number | null }

export const fetchType = async (typeID: number): Promise<TypeRecord | null> => {
  const type = getSdeType(typeID)
  if (!type) return null
  return { name: type.name, groupID: type.groupID, categoryID: type.categoryID }
}

// Resolve a blueprint's typeID-bearing record to the typeID of the item it
// builds. CCP names every blueprint "<Product> Blueprint", so we strip the
// suffix and match the product by exact name.
export const resolveProductTypeID = async (blueprintName: string): Promise<number | null> => {
  const productName = blueprintName.replace(/ Blueprint$/, '')
  if (productName === blueprintName) return null
  const results = searchSdeTypes(productName)
  const exact = results.find((r) => r.name.toLowerCase() === productName.toLowerCase())
  return exact?.typeID ?? null
}
