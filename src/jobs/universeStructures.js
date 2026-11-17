import { map, pipe, prop, reject } from 'ramda'

import { universeStructure } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'
import { cli, forEachSequential } from './lib.js'
import { isDefinitiveFailure, shouldStandDown, UNRESOLVED_TTL_DAYS, unresolvedCutoff } from './structureResolution.js'

const TAG = 'universe-structures'
const SCOPE = 'esi-universe.read_structures.v1'

// Player Upwell structures use ids in this range; NPC stations (≤64M) and solar
// systems sit far below it, and an item id in this range that's also one of the
// characters' own items is a ship/container, not a structure.
const STRUCTURE_ID_FLOOR = 100_000_000_000

// The candidate structure ids: every location we already extract that sits in
// the structure id range, from the asset hangars, orders, industry jobs,
// contracts, wallet transactions and parked clones, less our characters' own
// items (a ship or container, not a structure). A structure id in any of them is
// proof one of our characters has been there, which makes it worth a name — and
// it costs no ESI calls to harvest, since the rows are already in Postgres
// (docs/structure-universe/design.md). Contracts are the quiet win: a courier
// contract's start/end locations are often the only record of a structure a
// character docks at but keeps nothing in.
//
// One statement, structure_location_candidate_ids() (schema.sql, "One-statement
// id harvests"). It replaced eleven 1,000-row OFFSET walks over the same
// tables, each page re-reading every row before it — 492 pages over
// corp_contract alone, 2.05M blocks read and 1.68M temp blocks for one run.
const fetchCandidateIds = async () => {
  const { data, error } = await sudoSupabase.rpc('structure_location_candidate_ids', { p_floor: STRUCTURE_ID_FLOOR })
  if (error) throw new Error(`structure_location_candidate_ids failed: ${error.message}`)
  return map(Number, data ?? [])
}

// GET /universe/structures/{id} → universe_structure. Resolves and caches the
// names/systems of the player structures characters hold assets or clones in.
// Candidates are pooled across *all* linked characters and each is attempted against
// *every* scoped token until one can dock and resolve it — a structure only
// needs a single character with docking access, and that character is often not
// the one whose assets sit there. Cheap in steady state: candidates exclude
// structures we already know (our corp's, plus anything resolved before).
// Account-wide by construction, so it takes no character scope.
export const runUniverseStructures = async () => {
  const { data: tokens, error } = await sudoSupabase
    .from('token')
    .select('id, registration_id, refresh_token')
    .contains('scope', [SCOPE])
  if (error) throw error

  console.log(`[${TAG}] ${tokens?.length ?? 0} token(s) with ${SCOPE}`)
  if (!tokens || tokens.length === 0) return

  // Ids we don't need to resolve: our own corp structures and anything already
  // *named*. Rows without a name don't count as resolved — the hourly
  // structure-directory job seeds ids straight from ESI's public list with
  // nothing to call them, and treating those as done would mean nothing ever
  // put a name on them.
  const { data: corpStructs } = await sudoSupabase.from('corp_structure').select('structure_id')
  const { data: knownStructs } = await sudoSupabase
    .from('universe_structure')
    .select('structure_id')
    .not('name', 'is', null)
  const resolved = new Set(map(pipe(prop('structure_id'), Number), [...(corpStructs ?? []), ...(knownStructs ?? [])]))

  // Clones parked in player structures are among the candidates — the
  // character-clones job resolves what it can with each clone's own token, but
  // only a character with docking access can resolve a given structure, and
  // that's often a different character than the clone's owner.
  const locationIds = await fetchCandidateIds()
  console.log(`[${TAG}] ${locationIds.length} candidate id(s) seen in our locations`)

  // Structures a recent pass already established nobody can resolve. Re-asking
  // every token about each of these nightly is what pushed the job past its
  // function budget, so they're parked for UNRESOLVED_TTL_DAYS — long enough to
  // stop the churn, short enough that newly granted docking access is picked up
  // within the week.
  const { data: parkedRows, error: parkedErr } = await sudoSupabase
    .from('universe_structure')
    .select('structure_id')
    .is('name', null)
    .gt('unresolved_at', unresolvedCutoff())
  if (parkedErr) throw parkedErr
  const parkedIds = new Set(map(pipe(prop('structure_id'), Number), parkedRows ?? []))

  const candidates = reject((id) => resolved.has(id) || parkedIds.has(id), locationIds)
  console.log(
    `[${TAG}] ${candidates.length} candidate player structure(s) to resolve ` +
      `(${parkedIds.size} parked as unresolvable within the last ${UNRESOLVED_TTL_DAYS} day(s))`
  )
  if (candidates.length === 0) return

  // Refresh each token's access token at most once and remember the result, so
  // attempting many candidates against many tokens doesn't re-refresh. null means
  // the token couldn't be refreshed or no longer carries the scope.
  const accessByToken = new Map()
  const getAccess = async (tokenRow) => {
    if (accessByToken.has(tokenRow.id)) return accessByToken.get(tokenRow.id)
    let access = null
    try {
      const { access_token, scope } = await refreshAccessToken(tokenRow)
      if (scope.includes(SCOPE)) access = access_token
    } catch (e) {
      console.error(`[${TAG}] token ${tokenRow.id} refresh FAILED: ${e?.message}`)
    }
    accessByToken.set(tokenRow.id, access)
    return access
  }

  // Set once ESI's error budget runs low (or it starts answering 420). Every
  // remaining candidate is then left for the next run rather than spending the
  // rest of the function's lifetime collecting 420s — which is precisely how
  // this job used to die at the 800s timeout, recording nothing.
  let standDown = null

  // Try resolving `structureID` against tokens in order, stopping at the first
  // one that succeeds. `lastError` carries the most recent failure forward so a
  // structure nobody can resolve still reports why.
  const resolveAgainstTokens = async (structureID, remainingTokens, lastError) => {
    if (standDown || remainingTokens.length === 0) return { info: null, lastError }
    const [tokenRow, ...rest] = remainingTokens
    const access = await getAccess(tokenRow)
    if (!access) return resolveAgainstTokens(structureID, rest, lastError)
    try {
      const info = await universeStructure(access, structureID)
      return { info, lastError }
    } catch (e) {
      // Stop the whole pass, not just this structure: the error budget is
      // shared across every job, and pushing past it turns other characters'
      // legitimate lookups into 420s too.
      if (shouldStandDown(e)) {
        standDown = e
        return { info: null, lastError: e }
      }
      // Usually 403 = this character can't dock here; another linked character
      // might, so try the next token before giving up on this structure.
      return resolveAgainstTokens(structureID, rest, e)
    }
  }

  let upserted = 0
  let parked = 0
  let skipped = 0
  await forEachSequential(candidates, async (structureID) => {
    if (standDown) {
      skipped += 1
      return
    }
    const { info, lastError } = await resolveAgainstTokens(structureID, tokens, undefined)
    if (!info) {
      // Nobody could resolve it. If ESI answered definitively about the
      // structure (403 no docking access / 404 gone), park it for
      // UNRESOLVED_TTL_DAYS so tomorrow's pass doesn't spend another ~77 calls
      // being told the same thing. A stand-down or any other failure says
      // nothing about the structure, so it stays a candidate.
      if (isDefinitiveFailure(lastError)) {
        const { error: parkErr } = await sudoSupabase
          .from('universe_structure')
          .upsert(
            { structure_id: structureID, unresolved_at: new Date().toISOString() },
            { onConflict: 'structure_id' }
          )
        if (parkErr) console.warn(`[${TAG}] structure ${structureID} park failed: ${parkErr.message}`)
        else parked += 1
      }
      console.warn(
        `[${TAG}] structure ${structureID} unresolved by any token: ${lastError?.message ?? 'no scoped token'}`
      )
      return
    }
    const { error: upErr } = await sudoSupabase.from('universe_structure').upsert(
      {
        structure_id: structureID,
        name: info?.name ?? null,
        system_id: info?.solar_system_id ?? null,
        type_id: info?.type_id ?? null,
        owner_corporation_id: info?.owner_id ?? null,
        // Outranks 'everef' and 'public-list', so the hourly directory job
        // never overwrites a name we resolved with real docking access — this
        // is the only source that can name a *private* structure.
        source: 'esi-token',
        resolved_at: new Date().toISOString(),
        // Access was granted (or restored): clear any park so the row reads as
        // resolved rather than resolved-but-parked.
        unresolved_at: null,
      },
      { onConflict: 'structure_id' }
    )
    if (upErr) {
      console.warn(`[${TAG}] structure ${structureID} upsert failed: ${upErr.message}`)
      return
    }
    resolved.add(structureID)
    upserted += 1
  })
  console.log(
    `[${TAG}] resolved ${upserted} player structure name(s), parked ${parked} for ${UNRESOLVED_TTL_DAYS} day(s)`
  )
  if (standDown) {
    // Not a failure: a partial pass is the designed behaviour under a shared
    // error budget, and the parked ids mean the next run starts further along.
    // Logged loudly because a run that stands down every night means the
    // candidate set is growing faster than it can be worked through.
    console.warn(
      `[${TAG}] stood down on ESI's error budget with ${skipped} candidate(s) unattempted ` +
        `(${standDown.message}); they stay candidates for the next run`
    )
  }
}

cli(import.meta.url, TAG, runUniverseStructures)
