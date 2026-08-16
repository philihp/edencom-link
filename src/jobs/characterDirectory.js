import { filter, forEach, map, reduce, splitEvery } from 'ramda'

import { characterAffiliations, universeNames } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const TAG = 'character-directory'
const BATCH_SIZE = 1000

const isPositiveId = (n) => Number.isFinite(n) && n > 0

// POST /characters/affiliation/ (bulk, no token) → the public character
// directory: character → corporation → alliance, plus the corporation/alliance
// id→name tables and corporation.alliance_id. Also keeps doing what the retired
// character-affiliations job did (character_affiliation upsert +
// registration.corporation_id refresh), so the ESI endpoint is pulled once.
//
// Design: docs/sharing-layer/design.md (stage A). Splitting public identity
// into the world-readable character_directory (character id → name, corp,
// alliance, and the registration uuid extract tables key owners by) lets the
// sharing layer resolve a shared row's owner with a plain RLS join, never a
// SECURITY DEFINER bridge — and the directory carries NO user_id, so it can't
// correlate a user's alts.
//
// Names come from POST /universe/names/ (bulk) rather than per-id
// GET /corporations|alliances/{id}/: the affiliation response already yields
// corp→alliance for every corp our characters are in (the only corps the
// sharing layer needs an alliance for), so two bulk calls replace N unit GETs.
export const runCharacterDirectory = async () => {
  const { data: chars, error: charsErr } = await sudoSupabase
    .from('universe_name')
    .select('id, name')
    .eq('category', 'character')
  if (charsErr) throw charsErr

  // Linked characters, resolved regardless of the ESI scopes their token holds,
  // so their corp lands in registration even without a corp-scoped job.
  const { data: regs, error: regsErr } = await sudoSupabase
    .from('registration')
    .select('id, character_id, name, corporation_id')
    .not('character_id', 'is', null)
  if (regsErr) throw regsErr

  // Name each character we know of and map its EVE id → registration uuid. Later
  // Map entries win, so registration.name (authoritative for our own) overrides
  // the universe_name cache; characters with no known name are still keyed (null).
  const linkedRegs = filter((r) => isPositiveId(Number(r.character_id)), regs ?? [])
  const nameById = new Map([
    ...map(
      (c) => [Number(c.id), c.name],
      filter((c) => isPositiveId(Number(c.id)), chars ?? [])
    ),
    ...map(
      (r) => [Number(r.character_id), r.name],
      filter((r) => r.name != null, linkedRegs)
    ),
  ])
  const registrationByCharacter = new Map(map((r) => [Number(r.character_id), r.id], linkedRegs))

  const ids = [...nameById.keys()]
  console.log(`[${TAG}] resolving affiliations for ${ids.length} character(s)`)
  if (ids.length === 0) return

  const affiliations = await reduce(
    (affiliationsSoFar, batch) =>
      affiliationsSoFar.then(async (acc) => {
        try {
          return [...acc, ...(await characterAffiliations(batch))]
        } catch (e) {
          console.warn(`[${TAG}] characters/affiliation batch failed: ${e?.message}`)
          return acc
        }
      }),
    Promise.resolve([]),
    splitEvery(BATCH_SIZE, ids)
  )
  if (affiliations.length === 0) return

  const resolved = filter((a) => a.character_id != null && a.corporation_id != null, affiliations)

  // ── character_affiliation (retained duty) ───────────────────────────────────
  const affiliationRows = map(
    (a) => ({
      character_id: a.character_id,
      corporation_id: a.corporation_id,
      resolved_at: new Date().toISOString(),
    }),
    resolved
  )
  const { error: affErr } = await sudoSupabase
    .from('character_affiliation')
    .upsert(affiliationRows, { onConflict: 'character_id' })
  if (affErr) throw affErr
  console.log(`[${TAG}] upserted ${affiliationRows.length} character affiliation(s)`)

  // ── alliance / corporation directories ──────────────────────────────────────
  // corp → alliance from the affiliation rows (present iff the corp is in an
  // alliance); this covers every corp we care about, since our characters are
  // members of those corps.
  const allianceByCorp = new Map(
    map(
      (a) => [Number(a.corporation_id), Number(a.alliance_id)],
      filter((a) => a.alliance_id != null, resolved)
    )
  )
  const corpIds = [...new Set(map((a) => Number(a.corporation_id), resolved))]
  const allianceIds = [...new Set(allianceByCorp.values())]

  // One bulk name resolution for every corp + alliance id. Missing entries just
  // fall back to a null name (the row still carries the authoritative ids).
  const names = new Map()
  if (corpIds.length + allianceIds.length > 0) {
    await forEachSequential(splitEvery(BATCH_SIZE, [...corpIds, ...allianceIds]), async (batch) => {
      try {
        forEach((n) => names.set(Number(n.id), n.name), await universeNames(batch))
      } catch (e) {
        console.warn(`[${TAG}] universe/names batch failed: ${e?.message}`)
      }
    })
  }

  // Alliances first — corporation.alliance_id FKs to alliance(alliance_id).
  if (allianceIds.length > 0) {
    const allianceRows = map((id) => ({ alliance_id: id, name: names.get(id) ?? null }), allianceIds)
    const { error } = await sudoSupabase.from('alliance').upsert(allianceRows, { onConflict: 'alliance_id' })
    if (error) throw error
    console.log(`[${TAG}] upserted ${allianceRows.length} alliance(s)`)
  }

  const corporationRows = map(
    (id) => ({ corporation_id: id, name: names.get(id) ?? null, alliance_id: allianceByCorp.get(id) ?? null }),
    corpIds
  )
  const { error: corpErr } = await sudoSupabase
    .from('corporation')
    .upsert(corporationRows, { onConflict: 'corporation_id' })
  if (corpErr) throw corpErr
  console.log(`[${TAG}] upserted ${corporationRows.length} corporation(s)`)

  // ── character directory ─────────────────────────────────────────────────────
  const characterRows = map(
    (a) => ({
      character_id: Number(a.character_id),
      name: nameById.get(Number(a.character_id)) ?? null,
      corporation_id: Number(a.corporation_id),
      alliance_id: a.alliance_id != null ? Number(a.alliance_id) : null,
      registration_id: registrationByCharacter.get(Number(a.character_id)) ?? null,
      updated_at: new Date().toISOString(),
    }),
    resolved
  )
  const { error: charErr } = await sudoSupabase
    .from('character_directory')
    .upsert(characterRows, { onConflict: 'character_id' })
  if (charErr) throw charErr
  console.log(`[${TAG}] upserted ${characterRows.length} character directory row(s)`)

  // ── registration.corporation_id refresh (retained duty) ─────────────────────
  // Only registrations whose corp actually changed are touched, grouped into one
  // update per target corporation (accumulator mutated in place, the accepted
  // exception for building a collection in a reduce).
  const corpByCharacter = new Map(affiliationRows.map((r) => [Number(r.character_id), Number(r.corporation_id)]))
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

cli(import.meta.url, TAG, runCharacterDirectory)
