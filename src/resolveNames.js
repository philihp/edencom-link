import { filter, isNil, map, pick, pipe, prop, propEq, props, reduce, reject, splitEvery, unnest } from 'ramda'

import { universeNames } from './esi.js'
import { sudoSupabase } from './supabase.js'

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 1000
const PAGE_SIZE = 1000

// id → Number(id), point-free.
const idToNumber = pipe(prop('id'), Number)

// Ids known to universe_name already, as a Set for O(1) membership checks.
const knownIdSet = pipe(map(idToNumber), (ids) => new Set(ids))

// Page an unfiltered (or coarsely filtered) select past PostgREST's max_rows
// (1000) cap until a short page signals the end (same pattern as
// src/app/market/page.tsx / src/app/structure/revenue/page.tsx). Every table
// read below grows past 1000 rows over time (corp_wallet_journal,
// corp_wallet_transaction, universe_name itself, …); an unpaged .select()
// silently truncates to an arbitrary first page, which can drop the very ids
// a resolver is looking for and leave their names unresolved forever.
const selectAllRows = async (build) => {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    rows.push(...data)
    if (data.length < PAGE_SIZE) break
  }
  return rows
}

// The `known` universe_name lookup for a given set of candidate ids: chunk the
// ids themselves (BATCH_SIZE per .in() call, same cap as resolveAllIds) rather
// than range-paging the response, since each chunk's result can never exceed
// the chunk size.
const knownIdsAmong = async (ids) => {
  const known = []
  for (const batch of splitEvery(BATCH_SIZE, [...ids])) {
    const { data, error } = await sudoSupabase.from('universe_name').select('id').in('id', batch)
    if (error) throw error
    known.push(...(data ?? []))
  }
  return knownIdSet(known)
}

// A resolved id/name/category row, trimmed down to the universe_name upsert shape.
const toNameRow = pick(['id', 'name', 'category'])

// ESI /universe/names/ rejects the whole batch if any id is invalid, so bisect on failure
// until either the batch resolves or we narrow down to single bad ids we can drop.
export const resolveBatch = async (ids) => {
  if (ids.length === 0) return []
  try {
    return await universeNames(ids)
  } catch (e) {
    if (ids.length === 1) {
      console.warn(`[names] universe/names id=${ids[0]} failed: ${e?.message}`)
      return []
    }
    const mid = Math.floor(ids.length / 2)
    const [a, b] = await Promise.all([resolveBatch(ids.slice(0, mid)), resolveBatch(ids.slice(mid))])
    return [...a, ...b]
  }
}

// Resolve every id in BATCH_SIZE chunks (the names endpoint caps at 1000 ids per
// call) and flatten the results, one chunk at a time so we never hold more than
// one batch of in-flight requests. Shared by every resolve* function below.
export const resolveAllIds = (ids) =>
  reduce(
    (resolvedSoFar, batch) => resolvedSoFar.then(async (resolved) => [...resolved, ...(await resolveBatch(batch))]),
    Promise.resolve([]),
    splitEvery(BATCH_SIZE, ids)
  )

// Resolve and cache (in universe_name) the name of every party seen in the corp wallet journal over
// the last 30 days that we don't already have a name for. The UI reads universe_name to show who paid
// each unaccounted industry tax instead of a raw id. Cheap to run often: it only resolves ids missing
// from universe_name, so steady-state runs resolve nothing.
export const resolveCorpJournalNames = async () => {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString()

  const journal = await selectAllRows((from, to) =>
    sudoSupabase
      .from('corp_wallet_journal')
      .select('first_party_id, second_party_id')
      .gte('date', cutoff)
      .order('corporation_id', { ascending: true })
      .order('division', { ascending: true })
      .order('entry_id', { ascending: true })
      .range(from, to)
  )

  const journalPartyIds = pipe(map(props(['first_party_id', 'second_party_id'])), unnest, reject(isNil), map(Number))
  const ids = new Set(journalPartyIds(journal))

  const knownIds = await knownIdsAmong(ids)

  const toResolve = filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n), [...ids])
  console.log(`[names] corp journal: ${ids.size} unknown id(s) seen in last 30d, ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no names resolved')
    return
  }

  const rows = map(toNameRow, resolved)
  const { error: upErr } = await sudoSupabase.from('universe_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr

  const characterCount = filter(propEq('character', 'category'), rows).length
  console.log(`[names] upserted ${rows.length} name(s) (${characterCount} character)`)
}

// Resolve and cache (in universe_name) the name of every corporation the other
// extracts have seen — as a seller in corp_wallet_transaction (the market page
// labels corp sales by corp name), as a character affiliation, or as a structure
// owner. Only resolves missing ids, so steady-state runs do nothing.
export const resolveKnownCorpNames = async () => {
  const sources = [
    ['corp_wallet_transaction', 'corporation_id', 'transaction_id'],
    ['character_affiliation', 'corporation_id', 'character_id'],
    ['corp_structure', 'corporation_id', 'structure_id'],
  ]
  const ids = new Set()
  for (const [table, column, pk] of sources) {
    const rows = await selectAllRows((from, to) =>
      sudoSupabase.from(table).select(column).order(pk, { ascending: true }).range(from, to)
    )
    for (const row of rows) {
      const id = Number(row[column])
      if (Number.isFinite(id) && id > 0) ids.add(id)
    }
  }
  if (ids.size === 0) return

  const knownIds = await knownIdsAmong(ids)
  const toResolve = reject((id) => knownIds.has(id), [...ids])
  console.log(`[names] corporations: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)
  if (resolved.length === 0) return

  const rows = map(toNameRow, resolved)
  const { error: upErr } = await sudoSupabase.from('universe_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} corp name(s)`)
}

// Cache (in universe_name) the name of every NPC station that currently holds
// one of our assets. ESI marks those asset rows with location_type 'station',
// and their names resolve via universe/names (category 'station') — no docking
// token needed, unlike player Upwell structures (handled by the
// universe-structures job). Only resolves ids missing from universe_name, so
// steady-state runs do nothing. The assets page reads universe_name to label
// NPC station locations instead of a raw id.
export const resolveAssetStationNames = async () => {
  // Page through live asset rows located directly in an NPC station. Order by the
  // primary key so range paging is stable (an unordered .range() can skip rows).
  const PAGE = 1000
  const ids = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sudoSupabase
      .from('character_asset_over_time')
      .select('location_id')
      .eq('is_current', true)
      .eq('location_type', 'station')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!rows || rows.length === 0) break
    for (const r of rows) if (r.location_id != null) ids.add(Number(r.location_id))
    if (rows.length < PAGE) break
  }

  const known = await selectAllRows((from, to) =>
    sudoSupabase
      .from('universe_name')
      .select('id')
      .eq('category', 'station')
      .order('id', { ascending: true })
      .range(from, to)
  )
  const knownIds = knownIdSet(known)

  const toResolve = filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n), [...ids])
  console.log(`[names] asset stations: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no station names resolved')
    return
  }

  const rows = map(toNameRow, resolved)
  const { error: upErr } = await sudoSupabase.from('universe_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} station name(s)`)
}

// Page through live asset rows in `table` located directly in a solar system
// (location_type 'solar_system' — the item is floating in space, not docked
// anywhere), collecting distinct location_id values. Shared by
// resolveAssetSystemNames for the character/corp asset tables, which are
// otherwise identical here. Order by the primary key so range paging is
// stable (an unordered .range() can skip rows).
const collectFloatingSystemIds = async (table, ids) => {
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sudoSupabase
      .from(table)
      .select('location_id')
      .eq('is_current', true)
      .eq('location_type', 'solar_system')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    if (!rows || rows.length === 0) break
    for (const r of rows) if (r.location_id != null) ids.add(Number(r.location_id))
    if (rows.length < PAGE) break
  }
}

// Cache (in universe_name) the name of every solar system a character or corp
// asset is currently floating in directly (location_type 'solar_system' — no
// station/structure to resolve a name from otherwise). Only resolves ids
// missing from universe_name, so steady-state runs do nothing. The assets
// pages read universe_name to label these roots instead of falling back to a
// raw system_id.
export const resolveAssetSystemNames = async () => {
  const ids = new Set()
  await collectFloatingSystemIds('character_asset_over_time', ids)
  await collectFloatingSystemIds('corp_asset_over_time', ids)

  const known = await selectAllRows((from, to) =>
    sudoSupabase
      .from('universe_name')
      .select('id')
      .eq('category', 'solar_system')
      .order('id', { ascending: true })
      .range(from, to)
  )
  const knownIds = knownIdSet(known)

  const toResolve = filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n), [...ids])
  console.log(`[names] asset systems: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no asset system names resolved')
    return
  }

  const rows = map(toNameRow, resolved)
  const { error: upErr } = await sudoSupabase.from('universe_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} asset system name(s)`)
}

// Cache (in universe_name) the name of every solar system we currently have a
// corp structure in. Only resolves ids missing from universe_name, so
// steady-state runs do nothing. The structures page reads universe_name to label
// each tile's system instead of falling back to a raw system_id.
export const resolveCorpStructureSystemNames = async () => {
  const structures = await selectAllRows((from, to) =>
    sudoSupabase.from('corp_structure').select('system_id').order('structure_id', { ascending: true }).range(from, to)
  )

  const systemId = pipe(prop('system_id'), Number)
  const ids = new Set(map(systemId, reject(pipe(prop('system_id'), isNil), structures)))

  const known = await selectAllRows((from, to) =>
    sudoSupabase
      .from('universe_name')
      .select('id')
      .eq('category', 'solar_system')
      .order('id', { ascending: true })
      .range(from, to)
  )
  const knownIds = knownIdSet(known)

  const toResolve = filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n), [...ids])
  console.log(`[names] corp structure systems: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no system names resolved')
    return
  }

  const rows = map(toNameRow, resolved)
  const { error: upErr } = await sudoSupabase.from('universe_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} system name(s)`)
}
