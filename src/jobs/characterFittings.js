import { filter, map, pipe, prop, reduce, sortBy, splitEvery } from 'ramda'

import { fittings } from '../esi.js'
import { recordEsiConditional } from '../observability.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-fittings'
const SCOPE = 'esi-fittings.read_fittings.v1'

// The scope of the fitting's owner. ESI only exposes a character's personal
// fittings today — there is no corporation or alliance fittings endpoint (see
// docs/fittings.md) — but the column exists so that if CCP ever ships one,
// ingesting it is a new job writing a different value into this same table.
const OWNER_SCOPE = 'character'

// A fit's module list, normalized so two sightings of an unchanged fit compare
// equal regardless of the order ESI happened to serialize them in. Sorted by
// slot flag then type, and reduced to the three fields the fitting viewer
// needs — quantity is what distinguishes a slotted module (1) from a stack of
// charges or drones.
const normalizeItems = (items) =>
  pipe(
    map((i) => ({ type_id: Number(i.type_id), flag: i.flag ?? '', quantity: Number(i.quantity ?? 1) })),
    sortBy((i) => `${i.flag}:${i.type_id}`)
  )(items ?? [])

// The tracked attributes that define a version of a fitting row. A fit is
// edited in place in the client — same fitting_id, different modules — so any
// difference here opens a new SCD row and keeps what the fit used to be.
const signature = (f) =>
  JSON.stringify([f.name ?? null, f.description ?? null, Number(f.ship_type_id), normalizeItems(f.items)])

// PostgREST caps a single select; page through every open row so a character
// with a big fitting library doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (registration_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('character_fitting_over_time')
    .select(cols)
    .eq('registration_id', registration_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(registration_id, cols, from + PAGE))]
}

// Reconcile freshly fetched fittings against the character's current (open)
// rows in character_fitting_over_time (SCD type 2), the same approach the
// blueprints/orders jobs use: unchanged fits get their valid_until extended,
// edited ones close their old row and open a new one, and fits that vanished
// (deleted in the client) are closed. The character_fitting view of is_current
// rows then holds exactly the fits the character has saved right now.
const reconcile = async (registration_id, fetched) => {
  const cols = 'id, fitting_id, name, description, ship_type_id, items'
  const current = await fetchCurrentRows(registration_id, cols)

  const currentByFitting = new Map(current.map((c) => [Number(c.fitting_id), c]))
  // ESI could report the same fit twice if the library shifts mid-response;
  // collapse to one entry per fit so we never queue two inserts.
  const fetchedByFitting = new Map(fetched.map((f) => [Number(f.fitting_id), f]))

  const now = new Date().toISOString()

  // Classify each fetched fit against its current row: unchanged (touch),
  // edited (close + insert), or new (insert only). Built with a plain local
  // accumulator mutated via push, matching the sibling reconcilers — a fitting
  // library is small, but the shape stays the same as the ones where it matters.
  const { touchIds, closeIds, inserts } = reduce(
    (acc, f) => {
      const cur = currentByFitting.get(Number(f.fitting_id))
      if (cur && signature(cur) === signature(f)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({
          registration_id,
          owner_scope: OWNER_SCOPE,
          fitting_id: f.fitting_id,
          name: f.name ?? null,
          description: f.description ?? null,
          ship_type_id: f.ship_type_id,
          items: normalizeItems(f.items),
          valid_until: now,
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedByFitting.values()]
  )

  // Anything still open but not seen this run has been deleted in the client.
  const fetchedIds = new Set(fetchedByFitting.keys())
  const vanishedIds = pipe(
    filter((cur) => !fetchedIds.has(Number(cur.fitting_id))),
    map(prop('id'))
  )([...currentByFitting.values()])
  const allCloseIds = [...closeIds, ...vanishedIds]

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_fitting_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-fitting index never collides.
  await forEachSequential(splitEvery(200, allCloseIds), async (ids) => {
    const { error } = await sudoSupabase.from('character_fitting_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('character_fitting_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: allCloseIds.length }
}

// GET /characters/{id}/fittings/ → character_fitting_over_time (SCD type 2).
// ESI returns the character's whole saved-fitting library in one response,
// reconciled into versioned history. Conditional: a 304 means not one fit was
// added, edited or deleted since last run — the common case, since a fitting
// library changes far less often than assets or orders — so the whole
// reconcile is skipped.
export const runCharacterFittings = ({ characterIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, characterIds },
    async ({ access_token, characterID, character_id: registration_id, name }) => {
      const cacheKey = `${TAG}:${registration_id}`
      const priorEtag = await getEsiEtag(cacheKey)
      const t0 = Date.now()
      const { status, json: fetched, etag } = await fittings(access_token, characterID, priorEtag)
      const durationMs = Date.now() - t0
      if (status === 304) {
        recordEsiConditional({
          job: TAG,
          characterId: registration_id,
          characterName: name,
          outcome: 'not_modified',
          conditional: true,
          durationMs,
        })
        console.log(`[${TAG}] ${name} ${registration_id} (${characterID}): not modified`)
        return
      }

      const { touched, opened, closed } = await reconcile(registration_id, fetched)

      // Store the ETag only after the reconcile committed, so a mid-run failure
      // never leaves us skipping a fetch whose data we didn't persist.
      await putEsiEtag(cacheKey, etag)
      recordEsiConditional({
        job: TAG,
        characterId: registration_id,
        characterName: name,
        outcome: 'modified',
        conditional: priorEtag != null,
        rows: fetched.length,
        durationMs,
      })
      console.log(
        `[${TAG}] ${name} ${registration_id} (${characterID}): ${fetched.length} fitting(s); ${touched} unchanged, ${opened} opened, ${closed} closed`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterFittings)
