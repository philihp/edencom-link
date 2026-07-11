import { createClient } from '@supabase/supabase-js'
import { forEach, map, pluck, unnest } from 'ramda'

// The cron/GitHub Actions environment sets SUPABASE_URL / SUPABASE_KEY, but the
// Vercel runtime only exposes the NEXT_PUBLIC_* vars (same project). This module
// is imported in both — by the GitHub Actions jobs and by the Vercel queue
// consumer / the "Refresh ESI" server action via dispatchRefresh — so fall back
// to the public vars to keep createClient from throwing "supabaseUrl is required"
// on Vercel. The service key has no public equivalent and is set in both.
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY
const supabaseUsername = process.env.SUPABASE_USERNAME
const supabasePassword = process.env.SUPABASE_PASSWORD

export const supabase = createClient(supabaseUrl, supabaseKey)

export const sudoSupabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

export const sudoSupabaseAdmin = sudoSupabase.auth.admin

// The GitHub Actions run that invoked us (empty when run locally), plus a link
// straight to it. Used to land a run's start/end heartbeats on one row.
const githubRun = () => {
  const runId = process.env.GITHUB_RUN_ID
  if (!runId) return { run_id: null, run_attempt: null, run_url: null }
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repo = process.env.GITHUB_REPOSITORY ?? ''
  const attempt = process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null
  const run_url = `${server}/${repo}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`
  return { run_id: Number(runId), run_attempt: attempt, run_url }
}

// Record a scheduled job's progress in public.heartbeat. Workflows call this as
// two separate steps — once with phase "start" before the job and once with
// "end" after — so each run is a single row stamped with started_at, ended_at,
// and a link to the workflow run. The two steps of one GitHub run upsert onto
// the same row (keyed on job + run id + owner_key); run locally with no run id,
// each call is a standalone insert. Returns true on success, false (after
// logging) on failure so callers can decide whether a failed heartbeat should
// fail the whole step.
//
// opts.characterId/corporationId/userId attribute the row to the entity a
// per-character or per-corp job ran for (see forEachCharacter/forEachCorporation
// in src/jobs/lib.js, which pass these so a run's duration can later be broken
// down per job/character-or-corp/user rather than just per whole job invocation).
// Leave them unset for whole-job/account-wide jobs.
export const recordHeartbeat = async (job, phase = 'end', opts = {}) => {
  // GitHub Actions path: derive run identity from the environment so the two steps
  // of one workflow run land on a single row. Vercel queue path (and the
  // per-character/per-corp loops): the caller passes an explicit { runId } (and
  // source: 'vercel'), so its start/end pair up the same way without a
  // GITHUB_RUN_ID. run_id is bigint, so callers pass a bigint-safe id (not a
  // UUID); a non-null sentinel run_attempt keeps the upsert key fully non-null.
  const gh = githubRun()
  const run_id = opts.runId != null ? Number(opts.runId) : gh.run_id
  const run_attempt = opts.runId != null ? 1 : gh.run_attempt
  const run_url = opts.runUrl ?? gh.run_url
  const now = new Date().toISOString()
  const row = {
    job,
    run_id,
    run_attempt,
    run_url,
    character_id: opts.characterId ?? null,
    corporation_id: opts.corporationId ?? null,
    user_id: opts.userId ?? null,
    ...(phase === 'start' ? { started_at: now } : { ended_at: now }),
  }
  const table = sudoSupabase.from('heartbeat')
  const { error } =
    run_id != null
      ? await table.upsert(row, { onConflict: 'job,run_id,run_attempt,owner_key' })
      : await table.insert(row)
  if (error) {
    console.error(`[heartbeat] failed to record "${job}" ${phase}:`, error)
    return false
  }
  console.log(`[heartbeat] recorded: ${job} ${phase}`)
  return true
}

export const authenticate = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: supabaseUsername,
    password: supabasePassword,
  })
  return error ?? data
}

export const upsertCharacter = async (columns) => {
  const response = await supabase.from('registration').upsert(columns, { onConflict: 'user_id, owner' }).select()
  return response.data?.[0]?.id
}

export const upsertToken = async (columns) => {
  const response = await supabase
    .from('token')
    .upsert(columns, { onConflict: ['character_id'] })
    .select()
  if (response.error) console.error(response.error)
  return response.data?.[0]?.id
}

export const upsertAssets = async (assets) => {
  const response = await supabase
    .from('character_asset')
    .upsert(assets, { onConflict: ['item_id'] })
    .select()
  return response
}

export const selectCharacters = async (columns, owner) => {
  let query = supabase.from('registration').select(columns)
  if (owner !== undefined) query = query.eq('owner', owner)
  const response = await query
  return response?.data?.map((r) => r.id)
}

// Distinct registration ids that hold a token with ANY of the given ESI scopes.
// The Vercel cron producers use this to enumerate the characters to fan out one
// queue message per character. Throws on a lookup failure.
export const selectCharacterIdsWithScopes = async (scopes) => {
  const perScope = await Promise.all(
    map(async (scope) => {
      const { data, error } = await sudoSupabase.from('token').select('character_id').contains('scope', [scope])
      if (error) throw error
      return pluck('character_id', data ?? [])
    }, scopes)
  )
  return [...new Set(unnest(perScope))]
}

// Every character carrying any of `scopes`, grouped by corporation — `byCorp`
// maps corporation_id to the character ids known to belong to it; `unresolved`
// lists characters whose corporation hasn't been resolved yet (brand-new
// registrations). Used by the corp-scoped extract jobs (corp-assets,
// corp-industry-jobs, corp-wallet-transactions) to fan out exactly one queue
// message per corporation covering every character that might be able to
// authorize the pull — some carry the OAuth scope without the in-game role
// the ESI endpoint separately requires, and forEachCorporation (src/jobs/lib.js)
// needs the full group to fall back through if the first one it tries can't.
// Sending two *separate* messages for the same corp instead would race two
// concurrent reconciles against each other and corrupt the SCD-2 tables.
export const groupCharacterIdsByCorporation = async (scopes) => {
  const characterIds = await selectCharacterIdsWithScopes(scopes)
  if (characterIds.length === 0) return { byCorp: new Map(), unresolved: [] }

  const { data: registrations, error } = await sudoSupabase
    .from('registration')
    .select('id, corporation_id')
    .in('id', characterIds)
  if (error) throw error

  const byCorp = new Map()
  const unresolved = []
  forEach((r) => {
    if (r.corporation_id == null) {
      unresolved.push(r.id)
      return
    }
    const group = byCorp.get(r.corporation_id)
    if (group) group.push(r.id)
    else byCorp.set(r.corporation_id, [r.id])
  }, registrations ?? [])

  return { byCorp, unresolved }
}

export const selectToken = async (character_id, scope = []) => {
  const response = await supabase
    .from('token')
    .select('refresh_token, scope')
    .eq('character_id', character_id)
    .contains('scope', [scope].flat())
    .order('expires_at', { ascending: true })
  return response
}

// The last ETag stored for an ESI conditional-request cache key (a per-character
// snapshot endpoint — see esiConditionalJson in src/esi.js), or null if none.
// A lookup failure is swallowed to null so a missing/unreadable ETag just means
// an unconditional fetch — the extract still runs, it merely misses the 304.
export const getEsiEtag = async (cacheKey) => {
  const { data, error } = await sudoSupabase.from('esi_etag').select('etag').eq('cache_key', cacheKey).maybeSingle()
  if (error) {
    console.error(`[esi_etag] read failed for ${cacheKey}: ${error.message}`)
    return null
  }
  return data?.etag ?? null
}

// Store the ETag ESI returned for a cache key so the next run can send it as
// If-None-Match. Best-effort: a write failure is logged, not thrown, so it never
// aborts an extract that already succeeded.
export const putEsiEtag = async (cacheKey, etag) => {
  if (!etag) return
  const { error } = await sudoSupabase
    .from('esi_etag')
    .upsert({ cache_key: cacheKey, etag, updated_at: new Date().toISOString() }, { onConflict: 'cache_key' })
  if (error) console.error(`[esi_etag] write failed for ${cacheKey}: ${error.message}`)
}
