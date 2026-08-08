import { map, splitEvery } from 'ramda'

import { corpIndustryJobs } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { partitionJobs } from './industryJobReconcile.js'
import { cli, fetchAllPages, forEachCorporation, forEachSequential } from './lib.js'

const TAG = 'corp-industry-jobs'
export const SCOPE = 'esi-industry.read_corporation_jobs.v1'

// PostgREST caps a single select; page through every open row so a corp with a
// long job history doesn't silently truncate the "current" set.
const PAGE = 1000

const fetchCurrentRows = async (corporation_id, cols, from = 0) => {
  const { data, error } = await sudoSupabase
    .from('corp_industry_job_over_time')
    .select(cols)
    .eq('corporation_id', corporation_id)
    .eq('is_current', true)
    .order('id', { ascending: true })
    .range(from, from + PAGE - 1)
  if (error) throw error
  const page = data ?? []
  if (page.length < PAGE) return page
  return [...page, ...(await fetchCurrentRows(corporation_id, cols, from + PAGE))]
}

// Reconcile freshly fetched corp jobs against the corp's current (open) rows in
// corp_industry_job_over_time (SCD type 2), the same approach the
// character-industry-jobs job uses: unchanged jobs get valid_until extended,
// jobs whose state advanced close their old row and open a new one, and a job
// that dropped out of the ESI listing while still non-terminal is closed as
// aged out (see partitionJobs). A row that already reached a terminal status
// stays is_current even once ESI stops reporting it, so the corp_industry_job
// view retains every job we saw finish.
//
// `fetched` is the drained listing from fetchAllPages, which throws rather than
// returning a short list — so a job's absence here is real and not a page that
// failed to load. partitionJobs depends on that.
const reconcile = async (corporation_id, fetched) => {
  const cols = 'id, job_id, status, pause_date, completed_date, completed_character_id, successful_runs'
  const current = await fetchCurrentRows(corporation_id, cols)

  const now = new Date().toISOString()
  const { touchIds, closeIds, openJobs, agedOutIds } = partitionJobs(current, fetched)

  const inserts = map(
    (j) => ({
      job_id: j.job_id,
      corporation_id,
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
    const { error } = await sudoSupabase.from('corp_industry_job_over_time').update({ valid_until: now }).in('id', ids)
    if (error) throw error
  })
  // Close before inserting so the unique-current-per-job index never collides.
  // valid_until is left as-is: it records when the row was last *observed* in
  // this state, and neither a superseded row nor an aged-out one was observed
  // in it now.
  await forEachSequential(splitEvery(200, [...closeIds, ...agedOutIds]), async (ids) => {
    const { error } = await sudoSupabase.from('corp_industry_job_over_time').update({ is_current: false }).in('id', ids)
    if (error) throw error
  })
  await forEachSequential(splitEvery(1000, inserts), async (rows) => {
    const { error } = await sudoSupabase.from('corp_industry_job_over_time').insert(rows)
    if (error) throw error
  })

  return { touched: touchIds.length, opened: inserts.length, closed: closeIds.length, agedOut: agedOutIds.length }
}

// GET /corporations/{id}/industry/jobs/ → corp_industry_job_over_time (SCD type
// 2). Fetched with include_completed, so finished jobs get their terminal
// status recorded too. installer_id is the character who started each job.
export const runCorpIndustryJobs = ({ registrationIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, registrationIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()
    const jobs = await fetchAllPages((page) => corpIndustryJobs(access_token, corporation_id, page))
    const { touched, opened, closed, agedOut } = await reconcile(corporation_id, jobs)
    console.log(
      `[${TAG}] ${ctx}: corp ${corporation_id} ${jobs.length} industry job(s); ${touched} unchanged, ${opened} opened, ${closed} closed, ${agedOut} aged out in ${Date.now() - t0}ms`
    )
  })

cli(import.meta.url, TAG, runCorpIndustryJobs)
