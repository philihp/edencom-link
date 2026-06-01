import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
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
// the same row (keyed on job + run id); run locally with no run id, each call is
// a standalone insert. Returns true on success, false (after logging) on failure
// so callers can decide whether a failed heartbeat should fail the whole step.
export const recordHeartbeat = async (job, phase = 'end') => {
  const { run_id, run_attempt, run_url } = githubRun()
  const now = new Date().toISOString()
  const row = {
    job,
    run_id,
    run_attempt,
    run_url,
    ...(phase === 'start' ? { started_at: now } : { ended_at: now }),
  }
  const table = sudoSupabase.from('heartbeat')
  const { error } =
    run_id != null ? await table.upsert(row, { onConflict: 'job,run_id,run_attempt' }) : await table.insert(row)
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
    .from('asset')
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

export const selectToken = async (character_id, scope = []) => {
  const response = await supabase
    .from('token')
    .select('refresh_token, scope')
    .eq('character_id', character_id)
    .contains('scope', [scope].flat())
    .order('expires_at', { ascending: true })
  return response
}
