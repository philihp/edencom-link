import { reduce, splitEvery } from 'ramda'

import { industryJobs } from '../esi.js'
import { recordEsiConditional } from '../observability.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter, forEachSequential } from './lib.js'

const TAG = 'character-industry-jobs'
const SCOPE = 'esi-industry.read_character_jobs.v1'

// The tracked attributes that define a version of an industry-job row: the
// state that advances over a job's life. The immutable fields (installer,
// facility, blueprint, runs, dates, cost, ...) are fixed at creation, so only
// these need to be compared. Timestamps are normalized to epoch millis so a
// value ESI serializes with a trailing Z compares equal to the same instant
// Postgres returns with a +00:00 offset (otherwise every run would churn a
// completed job into a new version).
const ts = (x) => (x == null ? null : new Date(x).getTime())
const signature = (j) =>
  JSON.stringify([
    j.status,
    ts(j.pause_date),
    ts(j.completed_date),
    j.completed_character_id == null ? null : Number(j.completed_character_id),
    j.successful_runs ?? null,
  ])

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
// delivered) close their old row and open a new one. Unlike the orders/assets
// reconcile, a job that drops out of the ESI listing (a delivered job aged past
// include_completed's window) is NOT closed — its terminal row stays is_current
// so the character_industry_job view keeps every job the endpoint ever
// reported, matching the old plain table (which never swept completed jobs).
const reconcile = async (registration_id, fetched) => {
  const cols = 'id, job_id, status, pause_date, completed_date, completed_character_id, successful_runs'
  const current = await fetchCurrentRows(registration_id, cols)

  const currentByJob = new Map(current.map((c) => [Number(c.job_id), c]))
  // ESI could report the same job twice if the set shifts mid-response;
  // collapse to one entry per job so we never queue two inserts.
  const fetchedByJob = new Map(fetched.map((j) => [Number(j.job_id), j]))

  const now = new Date().toISOString()

  // Classify each fetched job against its current row: unchanged (touch),
  // advanced (close + insert), or new (insert only). Built with a plain local
  // accumulator mutated via push to keep the pass O(n) (cf. character-blueprints).
  const { touchIds, closeIds, inserts } = reduce(
    (acc, j) => {
      const cur = currentByJob.get(Number(j.job_id))
      if (cur && signature(cur) === signature(j)) {
        acc.touchIds.push(cur.id)
      } else {
        if (cur) acc.closeIds.push(cur.id)
        // valid_from is left to its `default now()` so it marks this version's debut.
        acc.inserts.push({
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
        })
      }
      return acc
    },
    { touchIds: [], closeIds: [], inserts: [] },
    [...fetchedByJob.values()]
  )

  await forEachSequential(splitEvery(200, touchIds), async (ids) => {
    const { error } = await sudoSupabase
      .from('character_industry_job_over_time')
      .update({ valid_until: now })
      .in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-job index never collides.
  await forEachSequential(splitEvery(200, closeIds), async (ids) => {
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

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length }
}

// GET /characters/{id}/industry/jobs/ → character_industry_job_over_time (SCD
// type 2). Fetched with include_completed, so finished jobs get their terminal
// status recorded too. Conditional: a 304 means the job list and every status
// is unchanged since last run (nothing started or completed), so the whole
// reconcile is skipped.
export const runCharacterIndustryJobs = ({ characterIds } = {}) =>
  forEachCharacter(
    TAG,
    { scope: SCOPE, characterIds },
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

      const { touched, opened, closed } = await reconcile(registration_id, jobs)

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
        `[${TAG}] ${name} ${registration_id} (${characterID}): ${jobs.length} jobs; ${touched} unchanged, ${opened} opened, ${closed} closed`
      )
    }
  )

cli(import.meta.url, TAG, runCharacterIndustryJobs)
