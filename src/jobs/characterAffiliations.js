import { filter, map, pipe, prop, reduce, splitEvery } from 'ramda'

import { characterAffiliations } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'character-affiliations'
const BATCH_SIZE = 1000

const isPositiveId = (n) => Number.isFinite(n) && n > 0
const idToNumber = pipe(prop('id'), Number)

// POST /characters/affiliation/ → character_affiliation, and push each linked
// character's corporation back into registration.corporation_id. Maps each known
// character to the corporation they currently belong to, so the UI can show who
// paid industry tax and which corp they fly for. Affiliations are public (no
// token) and resolved in batches over every character id cached in universe_name
// UNION every linked registration's character. Including the registrations
// matters: registration.corporation_id is otherwise written only by
// forEachCorporation (src/jobs/lib.js), which runs only for corp-scoped jobs, so
// a character whose token carries no corp scope never got its corp populated —
// leaving it out of the corp-table RLS scope and the owner/share pickers
// (fetchOwners). This makes that population scope-independent and daily. Names
// for any newly seen corporations are picked up by the universe-names job.
export const runCharacterAffiliations = async () => {
  const { data: chars, error: charsErr } = await sudoSupabase
    .from('universe_name')
    .select('id')
    .eq('category', 'character')
  if (charsErr) throw charsErr

  // Linked characters, resolved regardless of the ESI scopes their token holds,
  // so their corp lands in registration even without a corp-scoped job.
  const { data: regs, error: regsErr } = await sudoSupabase
    .from('registration')
    .select('id, character_id, corporation_id')
    .not('character_id', 'is', null)
  if (regsErr) throw regsErr

  const ids = [
    ...new Set([
      ...filter(isPositiveId, map(idToNumber, chars ?? [])),
      ...filter(isPositiveId, map((r) => Number(r.character_id), regs ?? [])),
    ]),
  ]
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

  // Propagate each linked character's current corporation into its registration
  // row. Only registrations whose corp actually changed are touched, grouped
  // into one update per target corporation (the accumulator is mutated in place,
  // the accepted exception for building a collection in a reduce).
  const corpByCharacter = new Map(rows.map((r) => [Number(r.character_id), Number(r.corporation_id)]))
  const idsByCorp = reduce(
    (acc, reg) => {
      const current = reg.corporation_id == null ? null : Number(reg.corporation_id)
      const corp = corpByCharacter.get(Number(reg.character_id))
      if (corp != null && corp !== current) {
        if (!acc[corp]) acc[corp] = []
        acc[corp].push(reg.id)
      }
      return acc
    },
    {},
    regs ?? []
  )
  await forEachSequential(Object.entries(idsByCorp), async ([corp, regIds]) => {
    const { error } = await sudoSupabase
      .from('registration')
      .update({ corporation_id: Number(corp) })
      .in('id', regIds)
    if (error) {
      console.warn(`[${TAG}] registration.corporation_id update failed for corp ${corp}: ${error.message}`)
    } else {
      console.log(`[${TAG}] set corporation_id=${corp} on ${regIds.length} registration(s)`)
    }
  })
}

cli(import.meta.url, TAG, runCharacterAffiliations)
