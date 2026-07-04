import { randomInt } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { range, reduce } from 'ramda'

import { character as fetchCharacter } from '../esi.js'
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
const withHeartbeat = async (tag, owner, fn) => {
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat(tag, 'start', { runId, ...owner })
  try {
    return await fn()
  } finally {
    await recordHeartbeat(tag, 'end', { runId, ...owner })
  }
}

// Shared plumbing for the per-endpoint extract jobs. Every job follows the same
// shape: enumerate the tokens carrying the endpoint's ESI scope (optionally
// narrowed to specific registrations by `characterIds`, e.g. a single character
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

// Iterate the tokens that carry `scope`, calling handler once per token with
// { access_token, characterID, character_id, userId, name, ctx }. `characterID`
// is the EVE character id from the token; `character_id` is the registration
// uuid. Each call is wrapped in a start/end heartbeat attributed to that
// character (job/character_id/user_id), unless `heartbeat: false` — set by
// forEachCorporation, which records its own corp-attributed heartbeat instead
// so a corp job doesn't get two rows (one bare-character, one per-corp) for
// the same unit of work.
export const forEachCharacter = async (tag, { scope, characterIds, heartbeat = true }, handler) => {
  const { data: characters, error: charactersError } = await sudoSupabase
    .from('registration')
    .select('id, name, user_id')
  if (charactersError) {
    console.error(`[${tag}] character lookup failed:`, charactersError)
    throw charactersError
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))
  const characterUserId = new Map((characters ?? []).map((c) => [c.id, c.user_id]))

  let tokenQuery = sudoSupabase.from('token').select('id, character_id, refresh_token').contains('scope', [scope])
  if (characterIds) tokenQuery = tokenQuery.in('character_id', characterIds)
  const { data: tokens, error } = await tokenQuery
  if (error) {
    console.error(`[${tag}] token lookup failed:`, error)
    throw error
  }

  console.log(`[${tag}] found ${tokens?.length ?? 0} token(s) with ${scope}`)

  await forEachSequential(tokens ?? [], async (tokenRow) => {
    const name = characterName.get(tokenRow.character_id) ?? '?'
    const userId = characterUserId.get(tokenRow.character_id) ?? null
    const ctx = `character=${name} (${tokenRow.character_id}) token=${tokenRow.id}`
    const t0 = Date.now()
    try {
      const { access_token, characterID, scope: freshScope } = await refreshAccessToken(tokenRow)
      if (!freshScope.includes(scope)) {
        console.error(`[${tag}] ${ctx}: refreshed token no longer has ${scope}, skipping`)
        return
      }
      const run = () =>
        handler({ access_token, characterID, character_id: tokenRow.character_id, userId, name, ctx })
      if (heartbeat) {
        await withHeartbeat(tag, { characterId: tokenRow.character_id, userId }, run)
      } else {
        await run()
      }
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[${tag}] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  })
}

// Iterate the corporations reachable through tokens carrying `scope`, calling
// handler once per corporation with { access_token, corporation_id, character_id,
// ctx }. Two characters in the same corp resolve to one handler call per run.
// Also keeps registration.corporation_id fresh — the corp tables' RLS policies
// key off it. Returns the set of corporation ids handled. The handler call is
// wrapped in a start/end heartbeat attributed to the corp (and the character
// whose token authorized the pull, so "which user" is derivable too); the
// inner forEachCharacter's own per-character heartbeat is disabled to avoid a
// redundant second row for the same unit of work.
export const forEachCorporation = async (tag, { scope, characterIds }, handler) => {
  const seenCorps = new Set()
  await forEachCharacter(
    tag,
    { scope, characterIds, heartbeat: false },
    async ({ access_token, characterID, character_id, userId, ctx }) => {
      const info = await fetchCharacter(access_token, characterID)
      const corporation_id = info?.corporation_id
      if (!corporation_id) {
        console.error(`[${tag}] ${ctx}: character payload missing corporation_id`)
        return
      }
      const { error: charUpdateErr } = await sudoSupabase
        .from('registration')
        .update({ corporation_id })
        .eq('id', character_id)
      if (charUpdateErr) {
        console.error(`[${tag}] ${ctx}: registration.corporation_id update failed: ${charUpdateErr.message}`)
      }
      if (seenCorps.has(corporation_id)) {
        console.log(`[${tag}] ${ctx}: corp ${corporation_id} already pulled this run, skipping`)
        return
      }
      seenCorps.add(corporation_id)
      await withHeartbeat(tag, { characterId: character_id, corporationId: corporation_id, userId }, () =>
        handler({ access_token, corporation_id, character_id, ctx })
      )
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
