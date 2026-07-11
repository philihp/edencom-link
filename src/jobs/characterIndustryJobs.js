import { industryJobs } from '../esi.js'
import { getEsiEtag, putEsiEtag, sudoSupabase } from '../supabase.js'
import { cli, forEachCharacter } from './lib.js'

const TAG = 'character-industry-jobs'
const SCOPE = 'esi-industry.read_character_jobs.v1'

// GET /characters/{id}/industry/jobs/ → character_industry_job. Fetched with
// include_completed, so finished jobs get their terminal status recorded too.
// Conditional: a 304 means the job list and every status is unchanged since last
// run (nothing started or completed), so the upsert is skipped.
export const runCharacterIndustryJobs = ({ characterIds } = {}) =>
  forEachCharacter(TAG, { scope: SCOPE, characterIds }, async ({ access_token, characterID, character_id, name }) => {
    const cacheKey = `${TAG}:${character_id}`
    const { status, json: jobs, etag } = await industryJobs(access_token, characterID, await getEsiEtag(cacheKey))
    if (status === 304) {
      console.log(`[${TAG}] ${name} ${character_id} (${characterID}): not modified`)
      return
    }
    if (jobs.length > 0) {
      const rows = jobs.map((j) => ({
        job_id: j.job_id,
        character_id,
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
      }))
      const { error } = await sudoSupabase.from('character_industry_job').upsert(rows, { onConflict: 'job_id' })
      if (error) throw error
    }
    // Store the ETag only after the upsert committed (see characterOrders.js).
    await putEsiEtag(cacheKey, etag)
    console.log(`[${TAG}] ${name} ${character_id} (${characterID}): ${jobs.length} jobs`)
  })

cli(import.meta.url, TAG, runCharacterIndustryJobs)
