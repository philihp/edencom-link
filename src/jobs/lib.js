import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { range, reduce } from 'ramda'

import { character as fetchCharacter, isRoleDenial } from '../esi.js'
import { recordHeartbeat, sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'

// Wraps one character/corp's worth of work with a start/end heartbeat pair so
// its duration can be attributed to that entity (see recordHeartbeat's
// characterId/corporationId/userId). A fresh runId per call keeps this pairing
// independent of any GITHUB_RUN_ID — every character/corp handled in a single
// job invocation gets its own row, whether that invocation loops over many
// (a GitHub Actions cron) or just one (a Vercel queue message dispatched for a
// single character). Runs fn even if the heartbeat write fails; always records
// the end heartbeat, success or failure, so a thrown error still has a duration.
//
// `skipReasonOf(e)` lets a caller classify some throws as *not failures*: return
// a reason string and the end row lands with ok=true and skipped_reason set,
// instead of ok=false. The error still propagates — forEachCorporation uses this
// for the in-game-role denial, where the corp must stay unclaimed so a later
// character can try, but nothing has actually gone wrong.
const withHeartbeat = async (tag, owner, fn, { skipReasonOf } = {}) => {
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(tag, 'start', { runId, ...owner })
  try {
    const result = await fn()
    await recordHeartbeat(tag, 'end', { runId, ...owner, ok: true })
    return result
  } catch (e) {
    const skippedReason = skipReasonOf?.(e) ?? null
    // Stamp the outcome on the end row (heartbeat.ok/error/skipped_reason) and
    // rethrow — the caller's catch still logs and skips to the next
    // character/corp as before.
    await recordHeartbeat(
      tag,
      'end',
      skippedReason !== null
        ? { runId, ...owner, ok: true, skippedReason }
        : { runId, ...owner, ok: false, error: e?.message ?? e }
    )
    throw e
  }
}

// Shared plumbing for the per-endpoint extract jobs. Every job follows the same
// shape: enumerate the tokens carrying the endpoint's ESI scope (optionally
// narrowed to specific registrations by `registrationIds`, e.g. a single character
// fanned out from the Vercel queue), refresh each token, and hand the fresh
// access token to the job's handler. A failing character/corp is logged and
// skipped so one bad token never aborts the rest of the run; a fatal lookup
// failure throws so callers — the CLI wrapper or the queue consumer — can decide
// how to surface it.

// The jobs' preferred stand-in for `for (const item of items) { await ... }`:
// runs `fn` once per item, strictly in order, awaiting each before starting the
// next (a later item's failure never races an earlier one's write). Built on
// ramda's `reduce` chaining promises rather than resolving them — the reducer
// only runs once the accumulator settles, so this is sequential, not
// `Promise.all` fanned out. A rejection from `fn` propagates out of the whole
// chain immediately (subsequent items don't run), exactly like a thrown error
// escaping a `for` loop; wrap `fn` in try/catch to isolate one item's failure
// from the rest, as most callers below do.
export const forEachSequential = (items, fn) =>
  reduce((settled, item) => settled.then(() => fn(item)), Promise.resolve(), items)

// Load the registration id -> name / user_id maps once per run, shared by the
// token loops below. Throws on a lookup failure.
const loadCharacterMaps = async (tag) => {
  const { data: characters, error: charactersError } = await sudoSupabase
    .from('registration')
    .select('id, name, user_id')
  if (charactersError) {
    console.error(`[${tag}] character lookup failed:`, charactersError)
    throw charactersError
  }
  return {
    characterName: new Map((characters ?? []).map((c) => [c.id, c.name])),
    characterUserId: new Map((characters ?? []).map((c) => [c.id, c.user_id])),
  }
}

// The shared token loop: refresh each token, guard its refreshed scope with
// `hasScope(freshScope)`, and call `handler` with the token context (plus the
// fresh scope list, so a handler covering several endpoints can pick which to
// run per token). Each call is wrapped in a start/end heartbeat attributed to
// that character (job/registration_id/user_id), unless `heartbeat: false`. A
// failing token is logged and skipped so one bad token never aborts the rest.
const runTokenLoop = async (tag, tokens, { characterName, characterUserId, heartbeat }, hasScope, handler) => {
  await forEachSequential(tokens ?? [], async (tokenRow) => {
    const name = characterName.get(tokenRow.registration_id) ?? '?'
    const userId = characterUserId.get(tokenRow.registration_id) ?? null
    const ctx = `character=${name} (${tokenRow.registration_id}) token=${tokenRow.id}`
    const t0 = Date.now()
    try {
      const { access_token, characterID, scope: freshScope } = await refreshAccessToken(tokenRow)
      if (!hasScope(freshScope)) {
        console.error(`[${tag}] ${ctx}: refreshed token no longer carries the required scope, skipping`)
        return
      }
      const run = () =>
        handler({
          access_token,
          characterID,
          registration_id: tokenRow.registration_id,
          userId,
          name,
          ctx,
          scopes: freshScope,
        })
      if (heartbeat) {
        await withHeartbeat(tag, { registrationId: tokenRow.registration_id, userId }, run)
      } else {
        await run()
      }
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[${tag}] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  })
}

// Iterate the tokens that carry `scope`, calling handler once per token with
// { access_token, characterID, registration_id, userId, name, ctx, scopes }.
// `characterID` is the EVE character id from the token; `registration_id` is the
// registration uuid. Each call is wrapped in a start/end heartbeat attributed
// to that character (job/registration_id/user_id), unless `heartbeat: false` — set
// by forEachCorporation, which records its own corp-attributed heartbeat instead
// so a corp job doesn't get two rows (one bare-character, one per-corp) for
// the same unit of work.
export const forEachCharacter = async (tag, { scope, registrationIds, heartbeat = true }, handler) => {
  const { characterName, characterUserId } = await loadCharacterMaps(tag)

  let tokenQuery = sudoSupabase.from('token').select('id, registration_id, refresh_token').contains('scope', [scope])
  if (registrationIds) tokenQuery = tokenQuery.in('registration_id', registrationIds)
  const { data: tokens, error } = await tokenQuery
  if (error) {
    console.error(`[${tag}] token lookup failed:`, error)
    throw error
  }

  console.log(`[${tag}] found ${tokens?.length ?? 0} token(s) with ${scope}`)

  await runTokenLoop(tag, tokens, { characterName, characterUserId, heartbeat }, (s) => s.includes(scope), handler)
}

// Like forEachCharacter, but for a job that fronts several ESI endpoints with
// *different* scopes (see characterStatus.js). Selects every token carrying at
// least one of `scopes` (Postgres array overlap), and passes the token's fresh
// scope list to the handler as `scopes` so it can run only the endpoints that
// token is actually authorized for. One heartbeat per character, under `tag`.
export const forEachCharacterAnyScope = async (tag, { scopes, registrationIds, heartbeat = true }, handler) => {
  const { characterName, characterUserId } = await loadCharacterMaps(tag)

  let tokenQuery = sudoSupabase.from('token').select('id, registration_id, refresh_token').overlaps('scope', scopes)
  if (registrationIds) tokenQuery = tokenQuery.in('registration_id', registrationIds)
  const { data: tokens, error } = await tokenQuery
  if (error) {
    console.error(`[${tag}] token lookup failed:`, error)
    throw error
  }

  console.log(`[${tag}] found ${tokens?.length ?? 0} token(s) with any of [${scopes.join(', ')}]`)

  await runTokenLoop(
    tag,
    tokens,
    { characterName, characterUserId, heartbeat },
    (s) => scopes.some((scope) => s.includes(scope)),
    handler
  )
}

// Iterate the corporations reachable through tokens carrying `scope`, calling
// handler once per corporation with { access_token, corporation_id, registration_id,
// ctx }. Two characters in the same corp resolve to one handler call per run —
// unless the first one's call fails (most commonly a character that carries the
// OAuth scope but lacks the in-game role — director, accountant, etc — the corp
// endpoint itself requires), in which case the corp is left open for a later
// character to try, rather than being silently skipped for the rest of the run.
// Also keeps registration.corporation_id fresh — the corp tables' RLS policies
// key off it. Returns the set of corporation ids successfully handled. The
// handler call is wrapped in a start/end heartbeat attributed to the corp (and
// the character whose token authorized the pull, so "which user" is derivable
// too); the inner forEachCharacter's own per-character heartbeat is disabled to
// avoid a redundant second row for the same unit of work.
//
// A role denial is a **no-op, not a failure**: a pilot who isn't a director
// simply can't be asked for the corp's hangar, which is a fact about the pilot
// rather than a broken extract. Its heartbeat closes ok=true with a
// skipped_reason naming the character, so /jobs can say "not a director"
// instead of "✗ failed" (docs/jobs-page.md), and the corp is still left
// unclaimed so the next character in the group gets its turn.
// Remember (or forget) that this character was able to pull this corp endpoint.
// Observed capability, not a stated role: ESI never tells us which role the
// pilot holds, only whether the call was allowed, and that is exactly what the
// corp_structure_status fuel policy needs to gate on ("is a director of this
// corp"). Recording it here rather than in each job module keeps the fact
// wherever the role denial is already classified.
//
// Best-effort on purpose — a bookkeeping failure must not fail an extract that
// actually succeeded. The worst case is a director briefly losing sight of a
// fuel timer until the next run.
const recordCorpJobAccess = async (tag, registration_id, corporation_id, allowed) => {
  try {
    const { error } = allowed
      ? await sudoSupabase
          .from('corp_job_access')
          .upsert(
            { registration_id, corporation_id, job: tag, observed_at: new Date().toISOString() },
            { onConflict: 'registration_id,corporation_id,job' }
          )
      : await sudoSupabase
          .from('corp_job_access')
          .delete()
          .eq('registration_id', registration_id)
          .eq('corporation_id', corporation_id)
          .eq('job', tag)
    if (error) console.warn(`[${tag}] corp_job_access bookkeeping failed: ${error.message}`)
  } catch (e) {
    console.warn(`[${tag}] corp_job_access bookkeeping failed: ${e?.message ?? e}`)
  }
}

export const forEachCorporation = async (tag, { scope, registrationIds }, handler) => {
  const seenCorps = new Set()
  await forEachCharacter(
    tag,
    { scope, registrationIds, heartbeat: false },
    async ({ access_token, characterID, registration_id, userId, name, ctx }) => {
      const info = await fetchCharacter(access_token, characterID)
      const corporation_id = info?.corporation_id
      if (!corporation_id) {
        console.error(`[${tag}] ${ctx}: character payload missing corporation_id`)
        return
      }
      const { error: charUpdateErr } = await sudoSupabase
        .from('registration')
        .update({ corporation_id })
        .eq('id', registration_id)
      if (charUpdateErr) {
        console.error(`[${tag}] ${ctx}: registration.corporation_id update failed: ${charUpdateErr.message}`)
      }
      if (seenCorps.has(corporation_id)) {
        console.log(`[${tag}] ${ctx}: corp ${corporation_id} already pulled this run, skipping`)
        return
      }
      const skipReasonOf = (e) =>
        isRoleDenial(e) ? `${name} doesn't hold the in-game role this corp endpoint requires` : null
      try {
        await withHeartbeat(
          tag,
          { registrationId: registration_id, corporationId: corporation_id, userId },
          () => handler({ access_token, corporation_id, registration_id, ctx }),
          { skipReasonOf }
        )
      } catch (e) {
        const skipped = skipReasonOf(e)
        if (skipped === null) throw e
        // Swallowed rather than rethrown: runTokenLoop's catch would log this
        // as FAILED, and it isn't. The corp stays out of seenCorps either way,
        // so a corpmate with the role still gets a turn this run.
        console.log(`[${tag}] ${ctx}: ${skipped} — recorded as a skip, not a failure`)
        await recordCorpJobAccess(tag, registration_id, corporation_id, false)
        return
      }
      // Only mark the corp as handled once the pull actually succeeds.
      seenCorps.add(corporation_id)
      await recordCorpJobAccess(tag, registration_id, corporation_id, true)
    }
  )
  return seenCorps
}

// Drain an x-pages-paginated ESI endpoint. `fetchPage(page)` returns the
// [json, pagesHeader] tuple src/esi.js's paged wrappers produce. Pages 2..N are
// fetched strictly in order (ESI has no batch-by-page-numbers call), so this
// stays a sequential await chain over ramda's `range` rather than a `Promise.all`.
export const fetchAllPages = async (fetchPage) => {
  const [firstPage, pagesHeader] = await fetchPage(1)
  const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
  const rest = []
  await forEachSequential(range(2, totalPages + 1), async (page) => {
    const [more] = await fetchPage(page)
    rest.push(...(more ?? []))
  })
  return [...(firstPage ?? []), ...rest]
}

// PostgREST answers from a cached schema, so a table it hasn't reloaded yet is
// simply absent — the write comes back as PGRST205, "Could not find the table
// 'public.<name>' in the schema cache". Two ways to land in that window:
//
//   * writing to a table the same run just minted (sde-mirror creating an
//     sde_* table for a JSONL file CCP added), and
//   * writing to any table while PostgREST is mid-reload, which minting one of
//     those tables triggers.
//
// Both are transient, so wait the reload out rather than failing the job. The
// workflow's own step retries don't cover this: they fire within a few seconds
// of each other and then give up. The backoff sums to ~15s.
//
// PGRST205 has a second, non-transient cause worth knowing when reading logs: a
// table that genuinely does not exist. `sheet_csv` produced this exact error for
// three weeks because its migration was recorded as applied but never ran (see
// 20260814000000_repair_sheet_csv.sql). No retry helps there — the ladder just
// runs out and the caller reports the same failure ~15s later.
const SCHEMA_CACHE_MISS = 'PGRST205'
const RELOAD_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Run a PostgREST write, retrying while it reports a schema-cache miss, and
// return its final result unchanged so the caller keeps its own error message.
// `write` is a thunk (not a promise) because each attempt needs a fresh request.
export const writeWithSchemaRetry = async (label, write, attempt = 0) => {
  const result = await write()
  if (result.error?.code !== SCHEMA_CACHE_MISS || attempt >= RELOAD_BACKOFF_MS.length) return result
  const wait = RELOAD_BACKOFF_MS[attempt]
  console.log(`[schema-cache] ${label} not in PostgREST's schema cache yet, retrying in ${wait}ms`)
  await sleep(wait)
  return writeWithSchemaRetry(label, write, attempt + 1)
}

// Self-run a job when its module is invoked directly as a CLI
// (npm run <job> / the scheduled workflow). When the module is imported by the
// Next.js queue consumer instead, the top-level run must not fire.
export const cli = (moduleUrl, tag, run) => {
  if (process.argv[1] && fileURLToPath(moduleUrl) === process.argv[1]) {
    run().catch((e) => {
      console.error(`[${tag}] FAILED`, e)
      process.exit(1)
    })
  }
}
