// Shared plumbing for the MCP tools (see tools.ts). Every helper takes the
// token-scoped Supabase client built from the caller's OAuth access token, so
// RLS decides what each user can see — the helpers themselves never widen
// access. Type/system names resolve from the locally generated SDE data
// (never the stale evesde DB schema), everything else from the same caches
// the web pages use.
import type { SupabaseClient } from '@supabase/supabase-js'

import { fetchOwners } from '@/app/owners'
import type { LocationRef } from '@/app/resolveLocations'
import { searchSdeTypesAll, type SdeSearchResult } from '@/sdeTypes'
import { BLUEPRINT_CATEGORY_ID } from '@/utils/sdeCategories'

import type { OwnerDirectory } from './assetFilterQuery'

// Above this, the substring is too broad to be a useful item filter — same
// threshold (and rationale) as /asset/search.
export const MAX_TYPES = 100

// EVE's SDE Blueprint category (BPOs/BPCs and reaction formulas alike).
// Asset search excludes these by default, mirroring /asset/search. Re-exported
// from utils/ rather than declared here so the appraisal line builder — which is
// unit-tested, and so must not import this module's I/O — shares the one id.
export { BLUEPRINT_CATEGORY_ID }

// Keep individual responses readable — totals/summaries always cover the full
// result set, only the itemized list is capped.
export const MAX_ROWS = 200

export const capNote = (total: number, shown: number, what: string): string | undefined =>
  total > shown ? `Showing the first ${shown} of ${total} ${what}; counts and totals cover everything.` : undefined

// MCP tool results are text content blocks; every tool returns either a plain
// message or a JSON payload the model can read directly.
export type ToolResult = { content: Array<{ type: 'text'; text: string }> }

export const textResult = (payload: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
})

// Resolve a fuzzy item name to the single best-matching SDE type (highest
// coverage rank), surfacing the runner-up names so the model can correct a
// mis-pick. Used by the blueprint tools (which each act on one type) and the
// appraisal-fed manifests (appraise_items, shipping_quote).
export type ResolvedType =
  { ok: true; typeID: number; name: string; alsoMatched: string[] } | { ok: false; message: string }

export const resolveOneType = async (query: string): Promise<ResolvedType> => {
  const matches = await searchSdeTypesAll(query.trim())
  if (matches.length === 0) return { ok: false, message: `No item type matched "${query}".` }
  const [best, ...rest] = matches
  return { ok: true, typeID: best.typeID, name: best.name, alsoMatched: rest.slice(0, 4).map((m) => m.name) }
}

// Canonicalize a manifest of fuzzy item names for the appraisal service: each
// entry resolves to its SDE name when possible (noting when that differs from
// what was typed — a miss keeps the raw name so the API's own fuzzy handling
// can return possible_matches), and duplicate resolved names merge, since the
// API prices distinct lines separately, which would double-count the batch.
export type ManifestEntry = { item: string; quantity?: number }

export const resolveManifest = async (
  items: ManifestEntry[]
): Promise<{ lines: Array<{ name: string; quantity: number }>; notes: string[] }> => {
  const resolved = await Promise.all(
    items.map(async ({ item, quantity }) => {
      const match = await resolveOneType(item)
      const name = match.ok ? match.name : item.trim()
      return { input: item.trim(), name, quantity: quantity ?? 1 }
    })
  )
  const notes = resolved
    .filter((r) => r.name.toLowerCase() !== r.input.toLowerCase())
    .map((r) => `Interpreted "${r.input}" as ${r.name}.`)
  const merged = new Map<string, { name: string; quantity: number }>()
  resolved.forEach((r) => {
    const existing = merged.get(r.name)
    merged.set(r.name, { name: r.name, quantity: (existing?.quantity ?? 0) + r.quantity })
  })
  return { lines: [...merged.values()], notes }
}

// Resolve a fuzzy item-name query to SDE type ids, with the same "too many
// matches" guard as /asset/search so a broad substring can't walk a large
// chunk of the hangar (or bloat a `.in()` list). `null` query means no filter.
export type TypeFilter = { ok: true; matches: SdeSearchResult[] | null } | { ok: false; message: string }

export const resolveTypeFilter = async (
  query: string | undefined,
  { includeBlueprints = true } = {}
): Promise<TypeFilter> => {
  const trimmed = (query ?? '').trim()
  if (trimmed === '') return { ok: true, matches: null }
  const allMatches = await searchSdeTypesAll(trimmed)
  const matches = includeBlueprints ? allMatches : allMatches.filter((m) => m.categoryID !== BLUEPRINT_CATEGORY_ID)
  if (matches.length === 0) {
    const blueprintsOnlyMatched = !includeBlueprints && allMatches.length > 0
    return {
      ok: false,
      message: `No item types matched "${trimmed}"${
        blueprintsOnlyMatched ? ' (only blueprints did — set include_blueprints to search those too).' : '.'
      }`,
    }
  }
  if (matches.length > MAX_TYPES) {
    const sample = matches
      .slice(0, 10)
      .map((m) => m.name)
      .sort((a, b) => a.localeCompare(b))
    return {
      ok: false,
      message: `"${trimmed}" matched ${matches.length} item types — too many to search at once. Try a more specific term. A sample of what matched: ${sample.join(', ')}.`,
    }
  }
  return { ok: true, matches }
}

// Owner (character/corporation) display names for the caller, and an optional
// name filter over them. Owner ids are registration uuids for characters and
// corporation ids for corp-owned rows — the same convention the web pages use.
export type OwnerContext = {
  nameById: Map<string, string>
  registrationIds: string[]
  corporationIds: string[]
}

export const fetchOwnerContext = async (supabase: SupabaseClient): Promise<OwnerContext> => {
  const owners = await fetchOwners(supabase)
  return {
    nameById: new Map([...owners.characters, ...owners.corporations].map((o) => [o.id, o.name])),
    registrationIds: owners.characters.map((o) => o.id),
    corporationIds: owners.corporations.map((o) => o.id),
  }
}

// The same owners, plus the EVE numeric character id alongside each
// registration uuid, so a caller can name a character by either id (see
// splitOwnerIds). Kept out of fetchOwners itself, which is shared with the web
// pages and only ever needs the uuid the asset rows are keyed on.
export const fetchOwnerDirectory = async (
  supabase: SupabaseClient
): Promise<{ owners: OwnerContext; directory: OwnerDirectory }> => {
  const [owners, { data }] = await Promise.all([
    fetchOwnerContext(supabase),
    supabase.from('registration').select('id, character_id'),
  ])
  const rows = (data ?? []) as Array<{ id: string; character_id: number | string | null }>
  return {
    owners,
    directory: {
      registrations: rows.map((r) => ({
        registrationId: r.id,
        characterId: String(r.character_id ?? ''),
        name: owners.nameById.get(r.id) ?? r.id,
      })),
      corporations: owners.corporationIds.map((id) => ({
        corporationId: id,
        name: owners.nameById.get(id) ?? id,
      })),
    },
  }
}

// Case-insensitive substring match of an owner-name filter against the
// caller's characters and corporations. Returns the matching owner ids, or an
// error message listing what's available when nothing matches.
export type OwnerFilter = { ok: true; ownerIds: Set<string> | null } | { ok: false; message: string }

export const resolveOwnerFilter = (owner: string | undefined, ctx: OwnerContext): OwnerFilter => {
  const trimmed = (owner ?? '').trim().toLowerCase()
  if (trimmed === '') return { ok: true, ownerIds: null }
  const ids = [...ctx.nameById].filter(([, name]) => name.toLowerCase().includes(trimmed)).map(([id]) => id)
  if (ids.length === 0) {
    const available = [...ctx.nameById.values()].sort((a, b) => a.localeCompare(b))
    return { ok: false, message: `No character or corporation matched "${owner}". Available: ${available.join(', ')}.` }
  }
  return { ok: true, ownerIds: new Set(ids) }
}

// Orders/jobs/transactions carry a bare location_id with no type column. NPC
// stations live in a fixed id band, so classify those for the universe_name
// station cache; anything else resolves via the structure caches (or falls
// back to a labelled raw id) in resolveLocations.
export const guessLocationRef = (locationId: number | string | null | undefined): LocationRef | null => {
  if (locationId == null) return null
  const id = Number(locationId)
  return { id: String(locationId), type: id >= 60000000 && id < 64000000 ? 'station' : null }
}

// Page through a select past PostgREST's max_rows (1000) cap until a short
// page signals the end (cf. /market's fetchAllRows).
const PAGE_SIZE = 1000

export const fetchAllRows = async <T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> => {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error || !data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

// When the relevant extract jobs last completed for this user, so the model
// can caveat answers with how fresh the underlying snapshot is (extracts run
// on Vercel Cron, not on demand — see /jobs).
export const dataFreshness = async (supabase: SupabaseClient, jobs: string[]): Promise<Record<string, string>> => {
  const { data } = await supabase.rpc('latest_heartbeats')
  const rows = (data ?? []) as Array<{ job: string; ended_at: string }>
  const freshness: Record<string, string> = {}
  rows
    .filter((r) => jobs.includes(r.job))
    .forEach((r) => {
      if (!freshness[r.job] || r.ended_at > freshness[r.job]) freshness[r.job] = r.ended_at
    })
  return freshness
}
