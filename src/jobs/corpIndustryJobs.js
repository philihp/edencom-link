import { corpIndustryJobs } from '../esi.js'
import { sudoSupabase } from '../supabase.js'
import { cli, fetchAllPages, forEachCorporation } from './lib.js'

const TAG = 'corp-industry-jobs'
export const SCOPE = 'esi-industry.read_corporation_jobs.v1'

// GET /corporations/{id}/industry/jobs/ → corp_industry_job. Fetched with
// include_completed, so finished jobs get their terminal status recorded too.
// installer_id is the character who started each job.
export const runCorpIndustryJobs = ({ characterIds } = {}) =>
  forEachCorporation(TAG, { scope: SCOPE, characterIds }, async ({ access_token, corporation_id, ctx }) => {
    const t0 = Date.now()
    const jobs = await fetchAllPages((page) => corpIndustryJobs(access_token, corporation_id, page))

    const now = new Date().toISOString()
    const rows = jobs.map((j) => ({
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
      seen_at: now,
    }))
    if (rows.length > 0) {
      const { error } = await sudoSupabase.from('corp_industry_job').upsert(rows, { onConflict: 'job_id' })
      if (error) throw error
    }
    console.log(`[${TAG}] ${ctx}: corp ${corporation_id} ${rows.length} industry job(s) in ${Date.now() - t0}ms`)
  })

cli(import.meta.url, TAG, runCorpIndustryJobs)
