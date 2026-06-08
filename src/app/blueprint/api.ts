// Thin wrappers over the eve-build-calculator API (the same source as
// `typeNames.ts`), used to power blueprint search/lookup without touching the
// stale `evesde` schema. The app exposes:
//   GET /api/type/search?q=…   → [{ typeID, name, coverage }] ranked by relevance
//   GET /api/type/{typeID}     → the raw SDE type record (name, groupID, …)

const API = 'https://sde.edencom.link/api'

type TypeSearchResult = { typeID: number; name: string; coverage: number }

const nameEn = (name: { en?: string } | string | undefined): string | null => {
  if (name == null) return null
  return typeof name === 'string' ? name : (name.en ?? null)
}

const search = async (q: string): Promise<TypeSearchResult[]> => {
  const res = await fetch(`${API}/type/search?q=${encodeURIComponent(q)}`)
  if (!res.ok) return []
  return (await res.json()) as TypeSearchResult[]
}

// Search the type index by name, returning only blueprints as `[typeID, name]`.
// A complete-word query ("Rifter Blueprint") ranks the blueprint first, so we
// try the `… Blueprint`-suffixed query first; for a partial term ("rif") the
// search wants whole words, so we fall back to the raw query and keep the
// blueprint-named hits. Matches the old `'<substring>' & 'Blueprint'` behavior.
export const searchBlueprints = async (query: string): Promise<[typeID: string, name: string][]> => {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const blueprintsOnly = (results: TypeSearchResult[]) => results.filter((r) => r.name.endsWith('Blueprint'))
  const precise = blueprintsOnly(await search(`${trimmed} Blueprint`))
  const results = precise.length > 0 ? precise : blueprintsOnly(await search(trimmed))
  return results.map((r) => [`${r.typeID}`, r.name])
}

export type TypeRecord = { name: string | null; groupID: number | null; categoryID: number | null }

export const fetchType = async (typeID: number): Promise<TypeRecord | null> => {
  const res = await fetch(`${API}/type/${typeID}`)
  if (!res.ok) return null
  const type = (await res.json()) as { name?: { en?: string } | string; groupID?: number; categoryID?: number }
  return { name: nameEn(type.name), groupID: type.groupID ?? null, categoryID: type.categoryID ?? null }
}

// Resolve a blueprint's typeID-bearing record to the typeID of the item it
// builds. eve-build-calculator's search is keyed by name and CCP names every
// blueprint "<Product> Blueprint", so we strip the suffix and match the product
// by exact name.
export const resolveProductTypeID = async (blueprintName: string): Promise<number | null> => {
  const productName = blueprintName.replace(/ Blueprint$/, '')
  if (productName === blueprintName) return null
  const results = await search(productName)
  const exact = results.find((r) => r.name.toLowerCase() === productName.toLowerCase())
  return exact?.typeID ?? null
}
