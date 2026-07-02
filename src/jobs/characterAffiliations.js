import { filter, map, pipe, prop, reduce, splitEvery } from 'ramda'

import { characterAffiliations } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli } from './lib.js'

const TAG = 'character-affiliations'
const BATCH_SIZE = 1000

const isPositiveId = (n) => Number.isFinite(n) && n > 0
const idToNumber = pipe(prop('id'), Number)

// POST /characters/affiliation/ → character_affiliation. Maps each known
// character to the corporation they currently belong to, so the UI can show who
// paid industry tax and which corp they fly for. Affiliations are public (no
// token) and resolved in batches over every character id cached in
// universe_name; account-wide batch work, so it takes no character scope. Names
// for any newly seen corporations are picked up by the universe-names job.
export const runCharacterAffiliations = async () => {
  const { data: chars, error: charsErr } = await sudoSupabase
    .from('universe_name')
    .select('id')
    .eq('category', 'character')
  if (charsErr) throw charsErr

  const ids = filter(isPositiveId, map(idToNumber, chars ?? []))
  console.log(`[${TAG}] resolving affiliations for ${ids.length} character(s)`)
  if (ids.length === 0) return

  const affiliations = await reduce(
    (affiliationsSoFar, batch) =>
      affiliationsSoFar.then(async (affiliations) => {
        try {
          return [...affiliations, ...(await characterAffiliations(batch))]
        } catch (e) {
          console.warn(`[${TAG}] characters/affiliation batch failed: ${e?.message}`)
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
  const { error: upErr } = await sudoSupabase.from('character_affiliation').upsert(rows, { onConflict: 'character_id' })
  if (upErr) throw upErr
  console.log(`[${TAG}] upserted ${rows.length} character affiliation(s)`)
}

cli(import.meta.url, TAG, runCharacterAffiliations)
