import { forEach, map, splitEvery } from 'ramda'

import { universeStructures, userAgent } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli } from './lib.js'

const TAG = 'structure-directory'

// EVE Ref's continuously-scraped dump of everything publicly queryable about
// player structures — the live successor to the Hammertime Citadel Hunt API
// jEveAssets used to lean on (docs/structure-universe/design.md). ~874 KB, one
// JSON object keyed by structure id.
const EVEREF_URL = 'https://data.everef.net/structures/structures-latest.v2.json'

// Player Upwell structures use ids at or above this; NPC stations (≤64M) and
// solar systems sit far below it. Same floor universeStructures.js uses.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// PostgREST caps a single select, and upserting the whole directory in one
// request would be a needlessly large body.
const PAGE = 1000
const CHUNK = 500

// A row we resolved ourselves, with a real token and docking access, is better
// than EVE Ref's copy of a public scrape: it can name a *private* structure,
// and it was true for us at the time we read it. So the directory never lets a
// lower-priority feed overwrite one. Ranked rather than boolean so a third feed
// can slot in without rewriting the comparison.
const SOURCE_RANK = { 'esi-token': 3, everef: 2, 'public-list': 1 }
const outranks = (incoming, existing) => (SOURCE_RANK[incoming] ?? 0) >= (SOURCE_RANK[existing] ?? 0)

// Every directory row we already hold, drained past the PostgREST row cap by
// recursing to the next page until a short page signals the end. Ordered by the
// primary key so paging is stable — without an explicit sort PostgREST gives no
// row order, and an unordered .range() can skip or repeat rows across pages.
const fetchExisting = async (from = 0, acc = []) => {
  const { data, error } = await sudoSupabase
    .from('universe_structure')
    .select('structure_id, source')
    .order('structure_id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw new Error(`reading universe_structure failed: ${error.message}`)
  const page = data ?? []
  forEach((row) => acc.push(row), page)
  return page.length < PAGE ? acc : fetchExisting(from + PAGE, acc)
}

const fetchEveref = async () => {
  const response = await fetch(EVEREF_URL, { headers: { 'User-Agent': userAgent } })
  if (!response.ok) throw new Error(`EVE Ref structures fetch failed: ${response.status} ${response.statusText}`)
  return response.json()
}

const upsertChunks = async (rows, label) => {
  if (rows.length === 0) return
  await splitEvery(CHUNK, rows).reduce(
    (settled, chunk) =>
      settled.then(async () => {
        const { error } = await sudoSupabase.from('universe_structure').upsert(chunk, { onConflict: 'structure_id' })
        if (error) throw new Error(`upserting ${label} failed: ${error.message}`)
      }),
    Promise.resolve()
  )
}

// Two public feeds → universe_structure. Names every structure that can be
// named without a token, so the rest of the app (asset paths, market orders,
// industry jobs, contract endpoints) has something better than a raw id to
// show. Hourly: both feeds are small, unauthenticated and cheap.
//
// This does NOT replace universe-structures, the token-probe job. That one is
// the only thing that can name a *non-public* structure — one of ours, or one
// we hold assets in — because that needs a character with access, and EVE Ref
// by construction only has what's publicly queryable.
//
// Account-wide by construction, so it takes no character scope.
export const runStructureDirectory = async () => {
  const [everef, publicIds] = await Promise.all([fetchEveref(), universeStructures()])

  const publicSet = new Set(map(Number, publicIds ?? []))
  const everefById = new Map()
  forEach(
    (entry) => {
      const id = Number(entry?.structure_id)
      if (Number.isFinite(id) && id >= STRUCTURE_ID_FLOOR) everefById.set(id, entry)
    },
    Object.values(everef ?? {})
  )

  const existingSource = new Map(map((row) => [Number(row.structure_id), row.source], await fetchExisting()))

  console.log(
    `[${TAG}] ${everefById.size} EVE Ref structure(s), ${publicSet.size} public id(s), ${existingSource.size} already known`
  )

  // Three shapes, because a PostgREST bulk upsert builds one INSERT and updates
  // exactly the columns present in the payload — so rows that must only touch
  // is_public can't ride along with rows writing full identity.
  const identity = []
  const publicOnly = []
  const now = new Date().toISOString()

  forEach(
    (id) => {
      const is_public = publicSet.has(id)
      const entry = everefById.get(id)
      const existing = existingSource.get(id)
      if (entry && outranks('everef', existing)) {
        identity.push({
          structure_id: id,
          name: entry.name ?? null,
          system_id: entry.solar_system_id ?? null,
          type_id: entry.type_id ?? null,
          owner_corporation_id: entry.owner_id ?? null,
          is_public,
          source: 'everef',
          resolved_at: now,
        })
      } else if (existingSource.has(id)) {
        // Known already, and either EVE Ref has nothing to add or the row was
        // resolved with a token and outranks it. Keep the identity, refresh only
        // whether it's currently listed as public.
        publicOnly.push({ structure_id: id, is_public })
      } else {
        // In ESI's public list but nowhere else — we have an id and nothing to
        // call it. The token probe or a later EVE Ref pass may name it.
        publicOnly.push({ structure_id: id, is_public, source: 'public-list' })
      }
    },
    [...new Set([...everefById.keys(), ...publicSet, ...existingSource.keys()])]
  )

  // publicOnly holds two column shapes (with and without source), so split it
  // the same way rather than letting the shorter rows null out `source`.
  const withSource = publicOnly.filter((row) => row.source !== undefined)
  const withoutSource = publicOnly.filter((row) => row.source === undefined)

  await upsertChunks(identity, 'EVE Ref identities')
  await upsertChunks(withSource, 'public-list ids')
  await upsertChunks(withoutSource, 'public flags')

  console.log(
    `[${TAG}] wrote ${identity.length} identity row(s), ${withSource.length} new public id(s), ${withoutSource.length} public flag refresh(es)`
  )
}

cli(import.meta.url, TAG, runStructureDirectory)
