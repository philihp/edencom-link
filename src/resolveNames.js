import { splitEvery } from 'ramda'

import { universeNames } from './esi.js'
import { sudoSupabase } from './supabase.js'

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 1000

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
// call) and flatten the results. Shared by every resolve* function below and by
// the daily job's corp-name resolution.
export const resolveAllIds = async (ids) => {
  const resolved = []
  for (const batch of splitEvery(BATCH_SIZE, ids)) {
    resolved.push(...(await resolveBatch(batch)))
  }
  return resolved
}

// Resolve and cache (in eve_name) the name of every party seen in the corp wallet journal over the
// last 30 days that we don't already have a name for. The UI reads eve_name to show who paid each
// unaccounted industry tax instead of a raw id. Cheap to run often: it only resolves ids missing
// from eve_name, so steady-state runs resolve nothing.
export const resolveCorpJournalNames = async () => {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString()

  const { data: journal, error: journalErr } = await sudoSupabase
    .from('corp_wallet_journal')
    .select('first_party_id, second_party_id')
    .gte('date', cutoff)
  if (journalErr) throw journalErr

  const ids = new Set(
    (journal ?? []).flatMap((r) => [r.first_party_id, r.second_party_id].filter((v) => v != null).map(Number))
  )

  const { data: known, error: knownErr } = await sudoSupabase.from('eve_name').select('id')
  if (knownErr) throw knownErr
  const knownIds = new Set((known ?? []).map((k) => Number(k.id)))

  const toResolve = [...ids].filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n))
  console.log(`[names] corp journal: ${ids.size} unknown id(s) seen in last 30d, ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no names resolved')
    return
  }

  const rows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: upErr } = await sudoSupabase.from('eve_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr

  const characterCount = rows.filter((r) => r.category === 'character').length
  console.log(`[names] upserted ${rows.length} name(s) (${characterCount} character)`)
}

// Resolve and cache (in eve_name) the names of the given corporation ids that we
// don't already have. The market page reads eve_name to label corp market sales
// by corporation name instead of a raw id. Only resolves missing ids, so
// steady-state runs do nothing.
export const resolveCorpNames = async (corporationIds) => {
  const ids = [...new Set((corporationIds ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0))]
  if (ids.length === 0) return

  const { data: known, error: knownErr } = await sudoSupabase.from('eve_name').select('id').in('id', ids)
  if (knownErr) throw knownErr
  const knownIds = new Set((known ?? []).map((k) => Number(k.id)))
  const toResolve = ids.filter((id) => !knownIds.has(id))
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)
  if (resolved.length === 0) return

  const rows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: upErr } = await sudoSupabase.from('eve_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} corp name(s)`)
}

// Cache (in eve_name) the name of every NPC station that currently holds one of
// our assets. ESI marks those asset rows with location_type 'station', and their
// names resolve via universe/names (category 'station') — no docking token
// needed, unlike player Upwell structures (handled by resolveStructureNames).
// Only resolves ids missing from eve_name, so steady-state runs do nothing. The
// assets page reads eve_name to label NPC station locations instead of a raw id.
export const resolveAssetStationNames = async () => {
  // Page through live asset rows located directly in an NPC station. Order by the
  // primary key so range paging is stable (an unordered .range() can skip rows).
  const PAGE = 1000
  const ids = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await sudoSupabase
      .from('asset_over_time')
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

  const { data: known, error: knownErr } = await sudoSupabase.from('eve_name').select('id').eq('category', 'station')
  if (knownErr) throw knownErr
  const knownIds = new Set((known ?? []).map((k) => Number(k.id)))

  const toResolve = [...ids].filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n))
  console.log(`[names] asset stations: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no station names resolved')
    return
  }

  const rows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: upErr } = await sudoSupabase.from('eve_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} station name(s)`)
}

// Cache (in eve_name) the name of every solar system we currently have a corp
// structure in. Only resolves ids missing from eve_name, so steady-state runs do
// nothing. The structures page reads eve_name to label each tile's system instead
// of falling back to a raw system_id.
export const resolveCorpStructureSystemNames = async () => {
  const { data: structures, error: structuresErr } = await sudoSupabase.from('corp_structure').select('system_id')
  if (structuresErr) throw structuresErr

  const ids = new Set((structures ?? []).filter((r) => r.system_id != null).map((r) => Number(r.system_id)))

  const { data: known, error: knownErr } = await sudoSupabase
    .from('eve_name')
    .select('id')
    .eq('category', 'solar_system')
  if (knownErr) throw knownErr
  const knownIds = new Set((known ?? []).map((k) => Number(k.id)))

  const toResolve = [...ids].filter((n) => Number.isFinite(n) && n > 0 && !knownIds.has(n))
  console.log(`[names] corp structure systems: ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)

  if (resolved.length === 0) {
    console.log('[names] no system names resolved')
    return
  }

  const rows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: upErr } = await sudoSupabase.from('eve_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr
  console.log(`[names] upserted ${rows.length} system name(s)`)
}
