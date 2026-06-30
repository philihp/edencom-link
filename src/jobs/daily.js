import { fileURLToPath } from 'node:url'

import { filter, map, pick, pipe, prop, reduce, reject, splitEvery } from 'ramda'

import { characterAffiliations } from '../esi.js'
import { resolveAllIds, resolveCorpJournalNames } from '../resolveNames.js'
import { sudoSupabase } from '../supabase.js'

const BATCH_SIZE = 1000

const isPositiveId = (n) => Number.isFinite(n) && n > 0
const idToNumber = pipe(prop('id'), Number)

// Map each known character to the corporation they currently belong to, so the UI can show who paid
// industry tax and which corp they fly for. Affiliations are public (no token) and resolved in
// batches; any corp we haven't seen a name for yet gets resolved into eve_name too.
const resolveCharacterCorps = async () => {
  const { data: chars, error: charsErr } = await sudoSupabase.from('eve_name').select('id').eq('category', 'character')
  if (charsErr) throw charsErr

  const ids = filter(isPositiveId, map(idToNumber, chars ?? []))
  console.log(`[daily] character corps: resolving affiliations for ${ids.length} character(s)`)
  if (ids.length === 0) return

  const affiliations = await reduce(
    (affiliationsSoFar, batch) =>
      affiliationsSoFar.then(async (affiliations) => {
        try {
          return [...affiliations, ...(await characterAffiliations(batch))]
        } catch (e) {
          console.warn(`[daily] characters/affiliation batch failed: ${e?.message}`)
          return affiliations
        }
      }),
    Promise.resolve([]),
    splitEvery(BATCH_SIZE, ids)
  )
  if (affiliations.length === 0) return

  const rows = pipe(
    filter((a) => a.character_id != null && a.corporation_id != null),
    map((a) => ({
      character_id: a.character_id,
      corporation_id: a.corporation_id,
      resolved_at: new Date().toISOString(),
    }))
  )(affiliations)
  const { error: upErr } = await sudoSupabase.from('character_corp').upsert(rows, { onConflict: 'character_id' })
  if (upErr) throw upErr
  console.log(`[daily] upserted ${rows.length} character corp affiliation(s)`)

  // Resolve names for any corporations we don't already have a name for.
  const corpIds = new Set(filter(isPositiveId, map(pipe(prop('corporation_id'), Number), rows)))
  const { data: known, error: knownErr } = await sudoSupabase.from('eve_name').select('id')
  if (knownErr) throw knownErr
  const knownIds = new Set(map(idToNumber, known ?? []))

  const toResolve = reject((id) => knownIds.has(id), [...corpIds])
  if (toResolve.length === 0) return

  const resolved = await resolveAllIds(toResolve)
  if (resolved.length === 0) return

  const nameRows = map(pick(['id', 'name', 'category']), resolved)
  const { error: nameErr } = await sudoSupabase.from('eve_name').upsert(nameRows, { onConflict: 'id' })
  if (nameErr) throw nameErr
  console.log(`[daily] upserted ${nameRows.length} corporation name(s)`)
}

// Daily is batch work (not a per-character loop), so it runs whole-job. Throws on
// failure so callers — the CLI wrapper or the Vercel queue consumer — can decide
// how to surface it.
export const runDaily = async () => {
  await resolveCorpJournalNames()
  await resolveCharacterCorps()
}

const execute = async () => {
  try {
    await runDaily()
  } catch (e) {
    console.error('[daily] FAILED', e)
    process.exit(1)
  }
}

// Only run as a CLI (npm run daily / the scheduled workflow) when invoked directly.
// When imported by the Next.js queue consumer, the top-level run must not fire.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  execute()
}
