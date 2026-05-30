import { universeNames } from './esi.js'
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
  const { error: upErr } = await sudoSupabase
    .schema('hangar')
    .from('eve_name')
    .upsert(rows, { onConflict: 'id' })
  if (upErr) throw upErr

  const characterCount = rows.filter((r) => r.category === 'character').length
  console.log(`[daily] upserted ${rows.length} name(s) (${characterCount} character)`)
}

const execute = async () => {
  try {
    await resolveCorpJournalNames()
  } catch (e) {
    console.error('[daily] FAILED', e)
    process.exit(1)
  }
}

execute()
