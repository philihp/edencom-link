import { NextRequest, NextResponse } from 'next/server'

type TypeSearchResult = { typeID: number; name: string; coverage: number }

// In-memory cache of search results
const searchCache = new Map<string, TypeSearchResult[]>()

// Fetch a single type from the SDE API
async function fetchType(typeID: number): Promise<{ name: string } | null> {
  try {
    const res = await fetch(`https://sde.edencom.link/api/type/${typeID}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const type = (await res.json()) as { name?: { en?: string } | string }
    const name = typeof type.name === 'string' ? type.name : (type.name?.en ?? null)
    if (!name) return null
    return { name }
  } catch {
    return null
  }
}

// Known blueprint type IDs - populate these with actual FTL Interlinks and other blueprint IDs
// Format: typeID
// These can be added progressively as types are discovered
const KNOWN_BLUEPRINT_IDS: number[] = [
  // Add FTL Interlinks blueprint type IDs here
  // Example: 20400, // FTL Interlinks Blueprint (needs verification)
]

// Search known blueprints by name
async function searchKnownBlueprints(query: string): Promise<TypeSearchResult[]> {
  const results: TypeSearchResult[] = []
  const queryLower = query.toLowerCase()

  for (const typeID of KNOWN_BLUEPRINT_IDS) {
    const typeData = await fetchType(typeID)
    if (typeData && typeData.name.toLowerCase().includes(queryLower) && typeData.name.endsWith('Blueprint')) {
      results.push({
        typeID,
        name: typeData.name,
        coverage: 1.0,
      })
    }
  }

  return results
}

// Search by trying SDE type ID ranges
// This is a fallback for discovering types not in KNOWN_BLUEPRINT_IDS
async function searchByTypeRange(query: string): Promise<TypeSearchResult[]> {
  const results: TypeSearchResult[] = []
  const queryLower = query.toLowerCase()

  // Common blueprint ranges - these can be expanded as needed
  const rangesToSearch = [
    { start: 20400, end: 20450 },
    { start: 20800, end: 20850 },
  ]

  for (const range of rangesToSearch) {
    for (let typeID = range.start; typeID < range.end; typeID++) {
      const typeData = await fetchType(typeID)
      if (typeData && typeData.name.toLowerCase().includes(queryLower) && typeData.name.endsWith('Blueprint')) {
        results.push({
          typeID,
          name: typeData.name,
          coverage: 1.0,
        })
        if (results.length >= 4) break
      }
    }
    if (results.length >= 4) break
  }

  return results
}

// Main search function
async function searchBlueprints(query: string): Promise<TypeSearchResult[]> {
  const cacheKey = query.toLowerCase()
  const cached = searchCache.get(cacheKey)
  if (cached) return cached

  // Try known blueprints first
  let results = await searchKnownBlueprints(query)

  // If no results, try searching by range
  if (results.length === 0) {
    results = await searchByTypeRange(query)
  }

  searchCache.set(cacheKey, results)
  return results
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q')
  if (!q) {
    return NextResponse.json([])
  }

  try {
    const results = await searchBlueprints(q)
    return NextResponse.json(results)
  } catch {
    return NextResponse.json([])
  }
}
