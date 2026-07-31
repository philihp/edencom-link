import { characterMercenaryDen, characterMercenaryDens } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-mercenary-dens'
export const SCOPE = 'esi-structures.read_character.v1'

// GET /characters/{id}/structures/mercenary-dens (+ per-den detail) →
// character_mercenary_den_over_time (SCD-2 identity/config) + character_mercenary_den_status
// (append-only observed state). The listing is a full snapshot of the character's
// currently-deployed dens. The identity table is reconciled like
// character_asset_over_time: for each den, if its config (planet/type/skyhook) is
// unchanged the open row's valid_until is bumped; if it changed the open row is
// closed and a new one opened; dens that dropped out of the listing have their
// open row closed. The evolving status (development/anarchy, infomorphs, running
// state, reinforcement timer) drifts constantly, so rather than open a new SCD row
// every run we append one character_mercenary_den_status observation per den. A character
// can only field a handful, so the extra request + insert per den is cheap.

// The identity/config attributes that define a version of a den — any change
// opens a new SCD row.
const signature = (d) =>
  JSON.stringify([
    d.planet_id == null ? null : Number(d.planet_id),
    d.type_id == null ? null : Number(d.type_id),
    d.skyhook_id == null ? null : Number(d.skyhook_id),
    d.skyhook_corporation_id == null ? null : Number(d.skyhook_corporation_id),
  ])

export const syncCharacterMercenaryDens = async ({ access_token, characterID, registration_id, name }) => {
  const { mercenary_dens: listed = [] } = await characterMercenaryDens(access_token, characterID)

  // One timestamp for the whole character so valid_from/valid_until line up per run.
  const now = new Date().toISOString()

  // This character's current (open) den rows, keyed by den id.
  const { data: currentRows, error: curErr } = await sudoSupabase
    .from('character_mercenary_den_over_time')
    .select('id, den_id, planet_id, type_id, skyhook_id, skyhook_corporation_id')
    .eq('registration_id', registration_id)
    .eq('is_current', true)
  if (curErr) throw curErr
  const currentByDen = new Map((currentRows ?? []).map((r) => [Number(r.den_id), r]))

  await forEachSequential(listed, async (den) => {
    const detail = await characterMercenaryDen(access_token, characterID, den.id)
    const config = {
      planet_id: den.planet_id,
      type_id: detail.type_id ?? null,
      skyhook_id: detail.skyhook?.id ?? null,
      skyhook_corporation_id: detail.skyhook?.corporation_id ?? null,
    }

    const cur = currentByDen.get(Number(den.id))
    if (cur && signature(cur) === signature(config)) {
      // Unchanged config — extend the open row.
      const { error } = await sudoSupabase
        .from('character_mercenary_den_over_time')
        .update({ valid_until: now })
        .eq('id', cur.id)
      if (error) throw error
    } else {
      // Changed or brand new — close any open row, then open a fresh one.
      // Close before inserting so the unique-current-per-den index never collides.
      if (cur) {
        const { error } = await sudoSupabase
          .from('character_mercenary_den_over_time')
          .update({ is_current: false })
          .eq('id', cur.id)
        if (error) throw error
      }
      // valid_from is left to its `default now()` so it marks this version's debut.
      const { error } = await sudoSupabase
        .from('character_mercenary_den_over_time')
        .insert({ registration_id, den_id: den.id, ...config, valid_until: now })
      if (error) throw error
    }

    // Observed volatile state — appended as a new history row every run.
    const { error: statusError } = await sudoSupabase.from('character_mercenary_den_status').insert({
      registration_id,
      den_id: den.id,
      state: detail.state ?? null,
      development_level: detail.evolution?.development?.level ?? null,
      development_amount: detail.evolution?.development?.amount ?? null,
      anarchy_level: detail.evolution?.anarchy?.level ?? null,
      anarchy_amount: detail.evolution?.anarchy?.amount ?? null,
      infomorphs: detail.infomorphs?.amount ?? null,
      reinforcement_end: detail.reinforcement_timer?.end ?? null,
      observed_at: now,
    })
    if (statusError) throw statusError
  })

  // Dens still open but not listed this run have been unanchored/transferred —
  // close their open row (SCD keeps the history).
  const seen = new Set(listed.map((d) => Number(d.id)))
  const vanishedIds = (currentRows ?? []).filter((r) => !seen.has(Number(r.den_id))).map((r) => r.id)
  if (vanishedIds.length > 0) {
    const { error: closeErr } = await sudoSupabase
      .from('character_mercenary_den_over_time')
      .update({ is_current: false })
      .in('id', vanishedIds)
    if (closeErr) throw closeErr
  }

  console.log(`[${TAG}] ${name} ${registration_id} (${characterID}): ${listed.length} den(s)`)
}

export const runCharacterMercenaryDens = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, syncCharacterMercenaryDens)

cli(import.meta.url, TAG, runCharacterMercenaryDens)
