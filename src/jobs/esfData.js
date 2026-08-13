// Encodes the six eveship.fit protobuf files from the sde_* mirror and upserts
// them (base64-encoded) into the esf_data table, so the ship-fitting data can
// refresh when a new CCP SDE build lands without a redeploy. Run as the final
// step of the sde-mirror workflow (src/workflows/sdeMirror.ts) on every pass —
// it calls encodeEsfData() (src/buildEsfData.js) and writes the result to the
// DB. This is the ONLY thing that encodes ESF data now; the web app build no
// longer does (the /esf/[file] route serves these rows in place of the old
// build-time public/esf-data/ static files). Also runnable manually via the
// CLI or the unscheduled /api/cron/esf-data route.
//
// CLI-runnable: `node src/jobs/esfData.js` encodes against the current mirror
// and stamps the rows with the latest completed sde_build.
import { encodeEsfData, ESF_FILE_NAMES } from '../buildEsfData.js'
import { sudoSupabase } from '../supabase.js'
import { cli, writeWithSchemaRetry } from './lib.js'

// The build the encoded data corresponds to. The workflow passes the build it
// just ingested; the CLI falls back to the latest fully-mirrored build.
const latestCompletedBuild = async () => {
  const { data, error } = await sudoSupabase
    .from('sde_mirror_state')
    .select('build_number')
    .not('completed_at', 'is', null)
    .order('build_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`esf-data: reading sde_mirror_state failed: ${error.message}`)
  return data?.build_number ?? 0
}

// True when esf_data already holds all six files stamped with this build —
// so the workflow can call runEsfData() on every mirror run (including the
// build-unchanged skip path) and only pay the ~30s encode when it's actually
// stale. Any missing/older row makes it return false, forcing a re-encode.
const alreadyEncoded = async (build) => {
  const { data, error } = await sudoSupabase.from('esf_data').select('name').eq('sde_build', build)
  if (error) throw new Error(`esf-data: reading esf_data failed: ${error.message}`)
  const present = new Set((data ?? []).map((row) => row.name))
  return ESF_FILE_NAMES.every((name) => present.has(name))
}

/** @param {{ build?: number, force?: boolean }} [opts] */
export const runEsfData = async ({ build, force = false } = {}) => {
  const sdeBuild = build ?? (await latestCompletedBuild())
  if (!force && (await alreadyEncoded(sdeBuild))) {
    console.log(`esf-data: already encoded at sde_build ${sdeBuild}, skipping`)
    return { files: 0, build: sdeBuild, skipped: true }
  }
  const buffers = await encodeEsfData()
  const updatedAt = new Date().toISOString()
  const rows = Object.entries(buffers).map(([name, buffer]) => ({
    name,
    data: buffer.toString('base64'),
    sde_build: sdeBuild,
    updated_at: updatedAt,
  }))
  // Same schema-cache retry as its sibling tail step (see sheetCsv.js): this
  // runs inside an sde-mirror run that may be minting tables concurrently.
  const { error } = await writeWithSchemaRetry('esf_data', () =>
    sudoSupabase.from('esf_data').upsert(rows, { onConflict: 'name' })
  )
  if (error) throw new Error(`esf-data: upsert failed: ${error.message}`)
  console.log(`esf-data: upserted ${rows.length} files at sde_build ${sdeBuild}`)
  return { files: rows.length, build: sdeBuild }
}

cli(import.meta.url, 'esf-data', () => runEsfData())
