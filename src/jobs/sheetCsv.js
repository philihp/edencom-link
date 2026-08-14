// Builds the industry-planning spreadsheet's static CSVs from the sde_* mirror
// and upserts them (as plain text) into the sheet_csv table, so the sheet data
// can refresh when a new CCP SDE build lands without a redeploy. Run as a tail
// step of the sde-mirror workflow (src/workflows/sdeMirror.ts, the encodeSheets
// step) once its input tables (sde_types, sde_blueprints) have landed — it calls
// encodeSheetCsv() (src/buildSheetCsv.js) and writes the result to the DB. The
// /sheets/[file] route serves those rows for Google Sheets =IMPORTDATA(). Also
// runnable manually via the CLI or the unscheduled /api/cron/sheet-csv route.
//
// The sibling of src/jobs/esfData.js — same shape, but the payload is CSV text
// rather than base64 protobufs, and it reads sde_types/sde_blueprints instead of
// the ESF input tables.
//
// CLI-runnable: `node src/jobs/sheetCsv.js` encodes against the current mirror
// and stamps the rows with the latest completed sde_build.
import { encodeSheetCsv, SHEET_FILE_NAMES } from '../buildSheetCsv.js'
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
  if (error) throw new Error(`sheet-csv: reading sde_mirror_state failed: ${error.message}`)
  return data?.build_number ?? 0
}

// True when sheet_csv already holds every file stamped with this build — so the
// workflow can call runSheetCsv() on every mirror pass and only pay the encode
// when it's actually stale. Any missing/older row makes it return false, forcing
// a re-encode.
const alreadyEncoded = async (build) => {
  const { data, error } = await sudoSupabase.from('sheet_csv').select('name').eq('sde_build', build)
  if (error) throw new Error(`sheet-csv: reading sheet_csv failed: ${error.message}`)
  const present = new Set((data ?? []).map((row) => row.name))
  return SHEET_FILE_NAMES.every((name) => present.has(name))
}

/** @param {{ build?: number, force?: boolean }} [opts] */
export const runSheetCsv = async ({ build, force = false } = {}) => {
  const sdeBuild = build ?? (await latestCompletedBuild())
  if (!force && (await alreadyEncoded(sdeBuild))) {
    console.log(`sheet-csv: already encoded at sde_build ${sdeBuild}, skipping`)
    return { files: 0, build: sdeBuild, skipped: true }
  }
  const files = await encodeSheetCsv()
  const updatedAt = new Date().toISOString()
  const rows = Object.entries(files).map(([name, data]) => ({
    name,
    data,
    sde_build: sdeBuild,
    updated_at: updatedAt,
  }))
  // Retried on a schema-cache miss like every other PostgREST write here: this
  // step is the tail of an sde-mirror run that may have just minted new sde_*
  // tables, so it can be writing while PostgREST reloads.
  //
  // Note this is NOT what broke the 2026-08-13 run. That PGRST205 on sheet_csv
  // was a missing table, not a stale cache — its migration was recorded as
  // applied but never ran (20260814000000_repair_sheet_csv.sql). The retry
  // cannot fix an absent table; it just delays the same failure by ~15s.
  const { error } = await writeWithSchemaRetry('sheet_csv', () =>
    sudoSupabase.from('sheet_csv').upsert(rows, { onConflict: 'name' })
  )
  if (error) throw new Error(`sheet-csv: upsert failed: ${error.message}`)
  console.log(`sheet-csv: upserted ${rows.length} files at sde_build ${sdeBuild}`)
  return { files: rows.length, build: sdeBuild }
}

cli(import.meta.url, 'sheet-csv', () => runSheetCsv())
