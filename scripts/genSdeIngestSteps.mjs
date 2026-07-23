// Regenerates src/workflows/sdeIngestSteps.ts — one `'use step'` function per
// SDE file — from CCP's current export. Run when CCP adds/removes JSONL files
// and you want the new ones to get their own named ingest step (unknown files
// still ingest via sdeMirrorWorkflow's generic `ingestSlice` fallback in the
// meantime, so this is a nice-to-have, not required to keep the mirror working).
//
//   SUPABASE_URL=… SUPABASE_KEY=… node scripts/genSdeIngestSteps.mjs
//
// (Any non-empty SUPABASE_* values work — this only reads CCP's zip central
// directory over HTTP; the dummy client that src/jobs/sdeMirror.js constructs
// at import time is never used on this path.)
import { writeFileSync } from 'node:fs'

import { fetchLatestBuild, listEntries } from '../src/jobs/sdeMirror.js'

const OUT = 'src/workflows/sdeIngestSteps.ts'
const fnName = (stem) => `ingest_${stem}`

const { build, zipUrl } = await fetchLatestBuild()
const files = await listEntries(zipUrl)
const stems = files.map((f) => f.stem).sort()

const header = `// AUTO-GENERATED — do not edit by hand.
//
// One \`'use step'\` function per SDE file, so each ingest slice shows up in
// Vercel's Workflows observability under its own name (\`ingest_<stem>\`) instead
// of a wall of identical \`ingestSlice\` rows. Workflow step names are baked from
// the function name at build time (the runtime also uses them for replay-
// divergence detection), so distinct names require distinct source functions —
// hence this generated roster rather than a single parameterized step.
//
// The list is the JSONL entry set of CCP's SDE export, captured statically (see
// scripts/genSdeIngestSteps.mjs to regenerate against the current build). Files
// CCP adds later that aren't in this roster still ingest — sdeMirrorWorkflow
// falls back to the generic \`ingestSlice\` step for any stem not found here.
//
// Roster captured from SDE build ${build} (${stems.length} files).

export type SdeFile = {
  entry: string
  stem: string
  method: number
  compressedSize: number
  localOffset: number
}

export type IngestSliceStep = (
  zipUrl: string,
  file: SdeFile,
  build: number,
  startLine: number,
) => Promise<number>

// The step body, shared by every per-stem step. Lazy-imports the job module
// (its top-level supabase client needs env vars absent at build time), so the
// per-stem functions below stay one-liners whose only real difference is the
// name the workflow compiler reads off them.
const slice: IngestSliceStep = async (zipUrl, file, build, startLine) => {
  const { ingestEntrySlice } = await import('@/jobs/sdeMirror.js')
  return ingestEntrySlice(zipUrl, file, build, startLine)
}
`

const fns = stems
  .map(
    (stem) => `
async function ${fnName(stem)}(zipUrl: string, file: SdeFile, build: number, startLine: number): Promise<number> {
  'use step'
  return slice(zipUrl, file, build, startLine)
}`
  )
  .join('\n')

const mapBlock = `

// Stem → its named ingest step. sdeMirrorWorkflow looks a file's stem up here
// and falls back to the generic \`ingestSlice\` for anything not listed.
export const INGEST_STEPS: Record<string, IngestSliceStep> = {
${stems.map((stem) => `  ${stem}: ${fnName(stem)},`).join('\n')}
}
`

writeFileSync(OUT, `${header}\n${fns}\n${mapBlock}`)
console.error(`wrote ${OUT} with ${stems.length} steps, build ${build}`)
