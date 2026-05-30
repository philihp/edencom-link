import { characterAffiliations, universeNames } from './esi.js'
import { sudoSupabase } from './supabase.js'

const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 1000

// ESI /universe/names/ rejects the whole batch if any id is invalid, so bisect on failure
// until either the batch resolves or we narrow down to single bad ids we can drop.
const resolveBatch = async (ids) => {
  if (ids.length === 0) return []
  try {
    return await universeNames(ids)
  } catch (e) {
    if (ids.length === 1) {
      console.warn(`[daily] universe/names id=${ids[0]} failed: ${e?.message}`)
      return []
    }
    const mid = Math.floor(ids.length / 2)
    const [a, b] = await Promise.all([resolveBatch(ids.slice(0, mid)), resolveBatch(ids.slice(mid))])
    return [...a, ...b]
  }
}

const resolveCorpJournalNames = async () => {
  const cutoff = new Date(Date.now() - LOOKBACK_MS).toISOString()

  const { data: journal, error: journalErr } = await sudoSupabase
    .schema('hangar')
    .from('corp_wallet_journal')
    .select('first_party_id, second_party_id')
    .gte('date', cutoff)
  if (journalErr) throw journalErr

  const ids = new Set()
  for (const r of journal ?? []) {
    if (r.first_party_id != null) ids.add(Number(r.first_party_id))
    if (r.second_party_id != null) ids.add(Number(r.second_party_id))
  }

  const { data: known, error: knownErr } = await sudoSupabase.schema('hangar').from('eve_name').select('id')
  if (knownErr) throw knownErr
  for (const k of known ?? []) ids.delete(Number(k.id))

  const toResolve = [...ids].filter((n) => Number.isFinite(n) && n > 0)
  console.log(`[daily] corp journal: ${ids.size} unknown id(s) seen in last 30d, ${toResolve.length} to resolve`)
  if (toResolve.length === 0) return

  const resolved = []
  for (let i = 0; i < toResolve.length; i += BATCH_SIZE) {
    const batch = toResolve.slice(i, i + BATCH_SIZE)
    const names = await resolveBatch(batch)
    resolved.push(...names)
  }

  if (resolved.length === 0) {
    console.log('[daily] no names resolved')
    return
  }

  const rows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: upErr } = await sudoSupabase.schema('hangar').from('eve_name').upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr

  const characterCount = rows.filter((r) => r.category === 'character').length
  console.log(`[daily] upserted ${rows.length} name(s) (${characterCount} character)`)
}

// Map each known character to the corporation they currently belong to, so the UI can show who paid
// industry tax and which corp they fly for. Affiliations are public (no token) and resolved in
// batches; any corp we haven't seen a name for yet gets resolved into eve_name too.
const resolveCharacterCorps = async () => {
  const { data: chars, error: charsErr } = await sudoSupabase
    .schema('hangar')
    .from('eve_name')
    .select('id')
    .eq('category', 'character')
  if (charsErr) throw charsErr

  const ids = (chars ?? []).map((c) => Number(c.id)).filter((n) => Number.isFinite(n) && n > 0)
  console.log(`[daily] character corps: resolving affiliations for ${ids.length} character(s)`)
  if (ids.length === 0) return

  const affiliations = []
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE)
    try {
      affiliations.push(...(await characterAffiliations(batch)))
    } catch (e) {
      console.warn(`[daily] characters/affiliation batch failed: ${e?.message}`)
    }
  }
  if (affiliations.length === 0) return

  const rows = affiliations
    .filter((a) => a.character_id != null && a.corporation_id != null)
    .map((a) => ({
      character_id: a.character_id,
      corporation_id: a.corporation_id,
      resolved_at: new Date().toISOString(),
    }))
  const { error: upErr } = await sudoSupabase
    .schema('hangar')
    .from('character_corp')
    .upsert(rows, { onConflict: 'character_id' })
  if (upErr) throw upErr
  console.log(`[daily] upserted ${rows.length} character corp affiliation(s)`)

  // Resolve names for any corporations we don't already have a name for.
  const corpIds = new Set(rows.map((r) => Number(r.corporation_id)).filter((n) => Number.isFinite(n) && n > 0))
  const { data: known, error: knownErr } = await sudoSupabase.schema('hangar').from('eve_name').select('id')
  if (knownErr) throw knownErr
  for (const k of known ?? []) corpIds.delete(Number(k.id))

  const toResolve = [...corpIds]
  if (toResolve.length === 0) return

  const resolved = []
  for (let i = 0; i < toResolve.length; i += BATCH_SIZE) {
    resolved.push(...(await resolveBatch(toResolve.slice(i, i + BATCH_SIZE))))
  }
  if (resolved.length === 0) return

  const nameRows = resolved.map((n) => ({ id: n.id, name: n.name, category: n.category }))
  const { error: nameErr } = await sudoSupabase.schema('hangar').from('eve_name').upsert(nameRows, { onConflict: 'id' })
  if (nameErr) throw nameErr
  console.log(`[daily] upserted ${nameRows.length} corporation name(s)`)
}

const execute = async () => {
  try {
    await resolveCorpJournalNames()
    await resolveCharacterCorps()
  } catch (e) {
    console.error('[daily] FAILED', e)
    process.exit(1)
  }
}

execute()
