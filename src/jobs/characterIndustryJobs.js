import { map, splitEvery } from 'ramda'

import { industryJobs } from '../esi.js'
import { recordEsiConditional } from '../observability.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { partitionJobs } from './industryJobReconcile.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-industry-jobs'
const SCOPE = 'esi-industry.read_character_jobs.v1'

// PostgREST caps a single select; page through every open row so a character
// with a long job history doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (registration_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('character_industry_job_over_time')
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

// Reconcile freshly fetched jobs against the character's current (open) rows in
// character_industry_job_over_time (SCD type 2): unchanged jobs get their
// valid_until extended, jobs whose state advanced (active → paused →
// delivered) close their old row and open a new one, and a job that dropped out
// of the ESI listing while still non-terminal is closed as aged out (see
// partitionJobs). A row that already reached a terminal status stays is_current
// even once ESI stops reporting it, so the character_industry_job view keeps
// every job we saw finish, matching the old plain table (which never swept
// completed jobs).
const reconcile = async (registration_id, fetched) => {
  const cols = 'id, job_id, status, pause_date, completed_date, completed_character_id, successful_runs'
  const current = await fetchCurrentRows(registration_id, cols)

  const now = new Date().toISOString()
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs(current, fetched)

  // valid_from is left to its `default now()` so it marks this version's debut.
  const inserts = map(
    (j) => ({
      job_id: j.job_id,
      registration_id,
      installer_id: j.installer_id,
      facility_id: j.facility_id,
      station_id: j.station_id ?? null,
      activity_id: j.activity_id,
      blueprint_id: j.blueprint_id,
      blueprint_type_id: j.blueprint_type_id,
      blueprint_location_id: j.blueprint_location_id,
      output_location_id: j.output_location_id,
      product_type_id: j.product_type_id ?? null,
      runs: j.runs,
      cost: j.cost ?? null,
      licensed_runs: j.licensed_runs ?? null,
      probability: j.probability ?? null,
      status: j.status,
      duration: j.duration,
      start_date: j.start_date,
      end_date: j.end_date,
      pause_date: j.pause_date ?? null,
      completed_date: j.completed_date ?? null,
      completed_character_id: j.completed_character_id ?? null,
      successful_runs: j.successful_runs ?? null,
      valid_until: now,
    }),
    openJobs
  )

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase
      .from('character_industry_job_over_time')
      .update({ valid_until: now })
      .in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-job index never collides.
  // valid_until is left as-is: it records when the row was last *observed* in
  // this state, and neither a superseded row nor an aged-out one was observed
  // in it now.
  await forEachSequential(splitEvery(200, [...closeIds, ...agedOutIds]), async (ids) => {
    const { error } = await sudoSupabase
      .from('character_industry_job_over_time')
      .update({ is_current: false })
      .in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('character_industry_job_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length, agedOut: agedOutIds.length }
}

// GET /characters/{id}/industry/jobs/ → character_industry_job_over_time (SCD
// type 2). Fetched with include_completed, so finished jobs get their terminal
// status recorded too. Conditional: a 304 means the job list and every status
// is unchanged since last run (nothing started or completed), so the whole
// reconcile is skipped.
export const runCharacterIndustryJobs = ({ registrationIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, registrationIds },
    async ({ access_token, characterID, registration_id, name }) => {
      const cacheKey = `${TAG}:${registration_id}`
      const priorEtag = await getEsiEtag(cacheKey)
      const t0 = Date.now()
      const { status, json: jobs, etag } = await industryJobs(access_token, characterID, priorEtag)
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

      const { touched, opened, closed, agedOut } = await reconcile(registration_id, jobs)

      // Store the ETag only after the reconcile committed (see characterOrders.js).
      await putEsiEtag(cacheKey, etag)
      recordEsiConditional({
        job: TAG,
        characterId: registration_id,
        characterName: name,
        outcome: 'modified',
        conditional: priorEtag != null,
        rows: jobs.length,
        durationMs,
      })
      console.log(
        `[${TAG}] ${name} ${registration_id} (${characterID}): ${jobs.length} jobs; ${touched} unchanged, ${opened} opened, ${closed} closed, ${agedOut} aged out`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterIndustryJobs)
