import { fileURLToPath } from 'node:url'

import { character as fetchCharacter } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { refreshAccessToken } from '../tokenRefresh.js'

// Shared plumbing for the per-endpoint extract jobs. Every job follows the same
// shape: enumerate the tokens carrying the endpoint's ESI scope (optionally
// narrowed to specific registrations by `characterIds`, e.g. a single character
// fanned out from the Vercel queue), refresh each token, and hand the fresh
// access token to the job's handler. A failing character/corp is logged and
// skipped so one bad token never aborts the rest of the run; a fatal lookup
// failure throws so callers — the CLI wrapper or the queue consumer — can decide
// how to surface it.

// Iterate the tokens that carry `scope`, calling handler once per token with
// { access_token, characterID, character_id, name, ctx }. `characterID` is the
// EVE character id from the token; `character_id` is the registration uuid.
export const forEachCharacter = async (tag, { scope, characterIds }, handler) => {
  const { data: characters, error: charactersError } = await sudoSupabase.from('registration').select('id, name')
  if (charactersError) {
    console.error(`[${tag}] character lookup failed:`, charactersError)
    throw charactersError
  }
  const characterName = new Map((characters ?? []).map((c) => [c.id, c.name]))

  let tokenQuery = sudoSupabase.from('token').select('id, character_id, refresh_token').contains('scope', [scope])
  if (characterIds) tokenQuery = tokenQuery.in('character_id', characterIds)
  const { data: tokens, error } = await tokenQuery
  if (error) {
    console.error(`[${tag}] token lookup failed:`, error)
    throw error
  }

  console.log(`[${tag}] found ${tokens?.length ?? 0} token(s) with ${scope}`)

  for (const tokenRow of tokens ?? []) {
    const name = characterName.get(tokenRow.character_id) ?? '?'
    const ctx = `character=${name} (${tokenRow.character_id}) token=${tokenRow.id}`
    const t0 = Date.now()
    try {
      const { access_token, characterID, scope: freshScope } = await refreshAccessToken(tokenRow)
      if (!freshScope.includes(scope)) {
        console.error(`[${tag}] ${ctx}: refreshed token no longer has ${scope}, skipping`)
        continue
      }
      await handler({ access_token, characterID, character_id: tokenRow.character_id, name, ctx })
    } catch (e) {
      const dt = Date.now() - t0
      console.error(`[${tag}] ${ctx}: FAILED after ${dt}ms name=${e?.name} message=${e?.message}\n${e?.stack ?? e}`)
    }
  }
}

// Iterate the corporations reachable through tokens carrying `scope`, calling
// handler once per corporation with { access_token, corporation_id, character_id,
// ctx }. Two characters in the same corp resolve to one handler call per run.
// Also keeps registration.corporation_id fresh — the corp tables' RLS policies
// key off it. Returns the set of corporation ids handled.
export const forEachCorporation = async (tag, { scope, characterIds }, handler) => {
  const seenCorps = new Set()
  await forEachCharacter(tag, { scope, characterIds }, async ({ access_token, characterID, character_id, ctx }) => {
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
    await handler({ access_token, corporation_id, character_id, ctx })
  })
  return seenCorps
}

// Drain an x-pages-paginated ESI endpoint. `fetchPage(page)` returns the
// [json, pagesHeader] tuple src/esi.js's paged wrappers produce.
export const fetchAllPages = async (fetchPage) => {
  const all = []
  const [firstPage, pagesHeader] = await fetchPage(1)
  all.push(...(firstPage ?? []))
  const totalPages = Math.max(1, Number.parseInt(pagesHeader, 10) || 1)
  for (let page = 2; page <= totalPages; page++) {
    const [more] = await fetchPage(page)
    all.push(...(more ?? []))
  }
  return all
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
