// Encodes the six eveship.fit protobuf files from the sde_* mirror and upserts
// them (base64-encoded) into the esf_data table, so the ship-fitting data can
// refresh when a new CCP SDE build lands without a redeploy. Chained into the
// sde-mirror workflow's finalize (src/workflows/sdeMirror.ts) — it reuses the
// same encode logic as the build-time esf:build step (encodeEsfData() in
// src/buildEsfData.js), just writing to the DB instead of public/esf-data/.
//
// CLI-runnable: `node src/jobs/esfData.js` encodes against the current mirror
// and stamps the rows with the latest completed sde_build.
import { encodeEsfData } from '../buildEsfData.js'
import { sudoSupabase } from '../supabase.js'
import { cli } from './lib.js'

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

export const runEsfData = async ({ build } = {}) => {
  const sdeBuild = build ?? (await latestCompletedBuild())
  const buffers = await encodeEsfData()
  const updatedAt = new Date().toISOString()
  const rows = Object.entries(buffers).map(([name, buffer]) => ({
    name,
    data: buffer.toString('base64'),
    sde_build: sdeBuild,
    updated_at: updatedAt,
  }))
  const { error } = await sudoSupabase.from('esf_data').upsert(rows, { onConflict: 'name' })
  if (error) throw new Error(`esf-data: upsert failed: ${error.message}`)
  console.log(`esf-data: upserted ${rows.length} files at sde_build ${sdeBuild}`)
  return { files: rows.length, build: sdeBuild }
}

cli(import.meta.url, 'esf-data', () => runEsfData())
