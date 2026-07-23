// Mirrors CCP's official Static Data Export into the public schema's sde_*
// tables (one table per JSONL file in the export — see
// supabase/migrations/20260716010000_sde_mirror.sql), replacing nothing yet:
// the app still reads the build-time generated JSON until the loader cutover.
//
// Scheduled nightly at 12:21 UTC as a Vercel Workflow
// (src/workflows/sdeMirror.ts), where every function invocation gets at most
// 60 seconds — hence the slice-shaped API here: ingestEntrySlice() does a
// bounded amount of work and returns a cursor for the next step to resume
// from. The CLI path (node src/jobs/sdeMirror.js [--force]) reuses the same
// functions with an unbounded budget, so each entry drains in one call.
//
// CCP serves the export as a ~100 MB zip behind a redirect to a build-pinned,
// immutable URL (eve-online-static-data-<build>-jsonl.zip) that supports HTTP
// Range requests, and the redirect carries the build number in an
// x-sde-build-number header. That shape does a lot of work for us:
//   - change detection is one HEAD request (skip when sde_mirror_state already
//     has the build completed);
//   - every workflow step reads the same immutable snapshot without staging a
//     copy anywhere, even if CCP flips "latest" mid-run;
//   - a step never downloads the whole zip — it Range-reads the central
//     directory once, then just its own entry's compressed bytes, which
//     node:zlib inflates (zip entries are raw deflate). No unzip binary, no
//     zip library.
import { randomInt } from 'node:crypto'
import { Readable } from 'node:stream'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import { map, splitEvery } from 'ramda'

import { userAgent } from '../esi.js'
import { recordPeakRss } from '../observability.js'
import { resolveAllIds } from '../resolveNames.js'
import { recordHeartbeat, sudoSupabase } from '../supabase.js'
import { cli, forEachSequential } from './lib.js'

const SDE_LATEST_URL = 'https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip'

// Upsert sizing: 500 rows per PostgREST call, additionally capped by payload
// bytes (typeDogma lines are huge). STEP_BUDGET_MS leaves headroom inside a
// 60 s workflow step for the entry download + inflate + a straggling upsert.
const CHUNK_ROWS = 500
const CHUNK_BYTES = 3_500_000
export const STEP_BUDGET_MS = 35_000

const PAGE = 1000

// ── Build discovery ─────────────────────────────────────────────────────────

// HEAD the "latest" URL without following the redirect: the 302 names the
// build-pinned zip (immutable, Range-capable) and carries x-sde-build-number.
// If CCP ever stops redirecting, fall back to the Last-Modified stamp as a
// stand-in build number over the latest URL itself.
export const fetchLatestBuild = async () => {
  const res = await fetch(SDE_LATEST_URL, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': userAgent },
  })
  const location = res.headers.get('location')
  if (res.status >= 300 && res.status < 400 && location) {
    const zipUrl = new URL(location, SDE_LATEST_URL).href
    const build = Number(res.headers.get('x-sde-build-number') ?? zipUrl.match(/-(\d+)-jsonl\.zip/)?.[1])
    if (Number.isFinite(build)) return { build, zipUrl }
    throw new Error(`sde-mirror: no build number on redirect to ${zipUrl}`)
  }
  const lastModified = res.headers.get('last-modified')
  if (!res.ok || !lastModified) throw new Error(`sde-mirror: HEAD ${SDE_LATEST_URL} → ${res.status}, no redirect`)
  return { build: Math.floor(Date.parse(lastModified) / 1000), zipUrl: SDE_LATEST_URL }
}

export const shouldSkip = async (build) => {
  const { data, error } = await sudoSupabase
    .from('sde_mirror_state')
    .select('completed_at')
    .eq('build_number', build)
    .maybeSingle()
  if (error) {
    console.error(`[sde-mirror] mirror_state read failed: ${error.message}`)
    return false
  }
  return data?.completed_at != null
}

export const markBuildStarted = async (build) => {
  const { error } = await sudoSupabase
    .from('sde_mirror_state')
    .upsert({ build_number: build }, { onConflict: 'build_number', ignoreDuplicates: true })
  if (error) throw error
}

// ── Zip plumbing ────────────────────────────────────────────────────────────
// Minimal central-directory reader over HTTP Range requests. Classic (non-64)
// zip only, which holds for CCP's export (~100 MB, ~50 entries). Low-level
// buffer scanning is deliberately imperative; the orchestration around it
// stays in the codebase's ramda idiom.

const fetchRange = async (url, start, end) => {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent, Range: `bytes=${start}-${end}` } })
  if (res.status === 206) return Buffer.from(await res.arrayBuffer())
  // A server ignoring Range replies 200 with the whole body; slice locally.
  if (res.status === 200) return Buffer.from(await res.arrayBuffer()).subarray(start, end + 1)
  throw new Error(`sde-mirror: GET ${url} bytes=${start}-${end} → ${res.status}`)
}

const fetchTail = async (url, length) => {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent, Range: `bytes=-${length}` } })
  if (res.status === 206) return Buffer.from(await res.arrayBuffer())
  if (res.status === 200) {
    const whole = Buffer.from(await res.arrayBuffer())
    return whole.subarray(Math.max(0, whole.length - length))
  }
  throw new Error(`sde-mirror: GET ${url} tail ${length} → ${res.status}`)
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50
// EOCD is 22 bytes plus an up-to-64KB comment; CCP's has no comment, but a
// 66KB tail read costs the same request either way.
const EOCD_TAIL = 66_000

// mapSolarSystems.jsonl → map_solar_systems (must satisfy
// ensure_sde_mirror_table's stem regex; anything that doesn't is skipped).
const toStem = (entryName) =>
  entryName
    .replace(/\.jsonl$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()

const STEM_RE = /^[a-z][a-z0-9_]{0,58}$/

// The zip's JSONL entries with what a later slice-step needs to Range-read
// just its own bytes: { entry, stem, method, compressedSize, localOffset }.
export const listEntries = async (zipUrl) => {
  const tail = await fetchTail(zipUrl, EOCD_TAIL)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('sde-mirror: zip end-of-central-directory not found')
  const cdSize = tail.readUInt32LE(eocd + 12)
  const cdOffset = tail.readUInt32LE(eocd + 16)
  const cd = await fetchRange(zipUrl, cdOffset, cdOffset + cdSize - 1)

  const entries = []
  let p = 0
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === CEN_SIG) {
    const method = cd.readUInt16LE(p + 10)
    const compressedSize = cd.readUInt32LE(p + 20)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    const localOffset = cd.readUInt32LE(p + 42)
    const entry = cd.toString('utf8', p + 46, p + 46 + nameLen)
    entries.push({ entry, method, compressedSize, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }

  const files = entries
    .filter(({ entry }) => entry.endsWith('.jsonl'))
    .map((e) => ({ ...e, stem: toStem(e.entry) }))
    .filter(({ entry, stem }) => {
      if (STEM_RE.test(stem)) return true
      console.error(`[sde-mirror] skipping ${entry}: "${stem}" is not a valid mirror table stem`)
      return false
    })
    .sort((a, b) => a.entry.localeCompare(b.entry))
  console.log(`[sde-mirror] zip lists ${files.length} JSONL entries`)
  return files
}

// Open one entry's decompressed bytes as a Node Readable, Range-reading only
// that entry's compressed bytes and inflating them incrementally — the peak
// held in memory is a decompression chunk, not the whole entry (typeDogma
// inflates to hundreds of MB, and buffering compressed + inflated at once was
// what forced the workflow function's memory sizing). The local header's
// name/extra lengths can differ from the central directory's, so read it first
// to find where the data actually starts. Abort `signal` to stop the download
// mid-entry (the slice budget expiring).
export const openEntryStream = async (zipUrl, file, signal) => {
  const local = await fetchRange(zipUrl, file.localOffset, file.localOffset + 29)
  if (local.readUInt32LE(0) !== LOC_SIG) throw new Error(`sde-mirror: bad local header for ${file.entry}`)
  const nameLen = local.readUInt16LE(26)
  const extraLen = local.readUInt16LE(28)
  const dataStart = file.localOffset + 30 + nameLen + extraLen
  const dataEnd = dataStart + file.compressedSize - 1
  if (file.method !== 0 && file.method !== 8)
    throw new Error(`sde-mirror: unsupported compression method ${file.method} for ${file.entry}`)

  const res = await fetch(zipUrl, {
    headers: { 'User-Agent': userAgent, Range: `bytes=${dataStart}-${dataEnd}` },
    signal,
  })
  if (res.status === 206) {
    const source = Readable.fromWeb(res.body)
    if (file.method === 0) return source
    const inflate = createInflateRaw()
    // pipe() doesn't forward errors; surface network failures to the consumer.
    source.on('error', (e) => inflate.destroy(e))
    return source.pipe(inflate)
  }
  // A server ignoring Range replies 200 with the whole zip; fall back to
  // buffering and slicing locally, as the Range path used to for every entry.
  if (res.status === 200) {
    const whole = Buffer.from(await res.arrayBuffer())
    const raw = whole.subarray(dataStart, dataEnd + 1)
    return Readable.from([file.method === 0 ? Buffer.from(raw) : inflateRawSync(raw)])
  }
  throw new Error(`sde-mirror: GET ${zipUrl} bytes=${dataStart}-${dataEnd} → ${res.status}`)
}

// ── Ingest ──────────────────────────────────────────────────────────────────

const ensureMirrorTable = async (stem, keyType) => {
  const { error } = await sudoSupabase.rpc('ensure_sde_mirror_table', { p_stem: stem, p_key_type: keyType })
  if (error) throw new Error(`sde-mirror: ensure_sde_mirror_table(${stem}) failed: ${error.message}`)
}

const upsertChunk = async (table, rows) => {
  const { error } = await sudoSupabase.from(table).upsert(rows, { onConflict: '_key' })
  if (error) throw new Error(`sde-mirror: upsert into ${table} failed: ${error.message}`)
}

// Rows that vanished from the current dump kept their old sde_build stamp;
// once a file has fully landed, sweep them.
const sweepStaleRows = async (table, build) => {
  const { error } = await sudoSupabase.from(table).delete().neq('sde_build', build)
  if (error) throw new Error(`sde-mirror: stale sweep of ${table} failed: ${error.message}`)
}

const logMemory = (label) => recordPeakRss({ job: 'sde-mirror', entry: label })

// Ingest one entry from line `startLine`, upserting {_key, data, sde_build}
// rows in bounded chunks until the entry is done (returns -1, after sweeping
// stale rows) or the time budget runs out (returns the cursor to resume from).
// Re-running a slice is idempotent — everything is keyed upserts — which is
// what makes the workflow's bounded step retries safe.
//
// The entry is consumed as a stream (openEntryStream): each decompressed chunk
// is walked for complete lines, with the partial trailing line carried into the
// next chunk, so peak memory is one chunk + one line + the pending upsert chunk
// rather than the whole inflated entry. Backpressure comes free — the download
// only advances as fast as the upserts drain — and when the budget expires the
// fetch is aborted instead of having already buffered the entry's tail.
// Deliberately imperative buffer walk, as before.
export const ingestEntrySlice = async (zipUrl, file, build, startLine = 0, budgetMs = STEP_BUDGET_MS) => {
  const t0 = Date.now()
  const table = `sde_${file.stem}`
  const abort = new AbortController()
  const stream = await openEntryStream(zipUrl, file, abort.signal)

  let line = 0
  let upserted = 0
  let chunk = []
  let chunkBytes = 0
  let carry = Buffer.alloc(0)
  let pauseLine = null
  let skipFile = false

  const flush = async () => {
    if (chunk.length === 0) return
    await upsertChunk(table, chunk)
    upserted += chunk.length
    chunk = []
    chunkBytes = 0
  }

  // Walk the complete lines in `combined`, returning the offset where the
  // partial trailing line begins (carried into the next chunk). Sets pauseLine
  // when the budget expires and skipFile when the entry has no _key to mirror.
  const walkLines = async (combined) => {
    let pos = 0
    while (pauseLine === null && !skipFile) {
      const nl = combined.indexOf(10, pos)
      if (nl === -1) break
      const lineStart = pos
      pos = nl + 1
      const thisLine = line++
      if (thisLine < startLine || nl <= lineStart) continue

      const text = combined.toString('utf8', lineStart, nl)
      if (text.trim() === '') continue
      const parsed = JSON.parse(text)

      // The first row of the file establishes the table (and its key type) —
      // resumed slices (startLine > 0) land in the table the first slice made.
      // An entry whose rows carry no _key (e.g. a metadata file) has no primary
      // key to mirror on; skip the whole file rather than erroring.
      if (startLine === 0 && upserted === 0 && chunk.length === 0) {
        if (parsed._key === undefined) {
          console.log(`[sde-mirror] ${file.entry}: rows carry no _key, skipping file`)
          skipFile = true
          return pos
        }
        await ensureMirrorTable(file.stem, typeof parsed._key === 'number' ? 'bigint' : 'text')
      }

      chunk.push({ _key: parsed._key, data: parsed, sde_build: build })
      chunkBytes += text.length
      if (chunk.length >= CHUNK_ROWS || chunkBytes >= CHUNK_BYTES) {
        await flush()
        if (Date.now() - t0 > budgetMs) pauseLine = thisLine + 1
      }
    }
    return pos
  }

  try {
    for await (const piece of stream) {
      const combined = carry.length ? Buffer.concat([carry, piece]) : piece
      const pos = await walkLines(combined)
      if (pauseLine !== null || skipFile) break
      carry = combined.subarray(pos)
    }
    // The last line of a drained entry may lack a trailing newline.
    if (pauseLine === null && !skipFile && carry.length > 0) {
      await walkLines(Buffer.concat([carry, Buffer.from('\n')]))
    }
  } finally {
    // Whether paused, skipped, or drained: stop the download. Breaking out of
    // for-await already destroyed the stream; swallow the abort-induced error
    // so it can't surface as an unhandled 'error' event.
    stream.on('error', () => {})
    abort.abort()
  }

  if (skipFile) return -1
  if (pauseLine !== null) {
    console.log(`[sde-mirror] ${file.entry}: +${upserted} rows, pausing at line ${pauseLine}`)
    logMemory(file.entry)
    return pauseLine
  }

  await flush()
  await sweepStaleRows(table, build)
  console.log(`[sde-mirror] ${file.entry}: +${upserted} rows, done (${line} lines)`)
  logMemory(file.entry)
  return -1
}

// ── Station names ───────────────────────────────────────────────────────────

const selectAllKeys = async (table, from = 0) => {
  const { data, error } = await sudoSupabase
    .from(table)
    .select('_key')
    .order('_key')
    .range(from, from + PAGE - 1)
  if (error) throw new Error(`sde-mirror: paging ${table} failed: ${error.message}`)
  const keys = map((r) => r._key, data ?? [])
  if (keys.length < PAGE) return keys
  return [...keys, ...(await selectAllKeys(table, from + PAGE))]
}

// The SDE carries a station's structure but not its display name (the game
// generates it from the owning corp/operation/celestial), so resolve names via
// ESI /universe/names/ into sde_npc_station_name. Deliberately never swept by
// build: an ESI hiccup degrades to the previous run's names.
export const resolveStationNames = async () => {
  const ids = await selectAllKeys('sde_npc_stations')
  console.log(`[sde-mirror] resolving ${ids.length} station names via ESI`)
  const resolved = await resolveAllIds(ids)
  const now = new Date().toISOString()
  const rows = map(({ id, name }) => ({ station_id: id, name, updated_at: now }), resolved)
  await forEachSequential(splitEvery(PAGE, rows), async (batch) => {
    const { error } = await sudoSupabase.from('sde_npc_station_name').upsert(batch, { onConflict: 'station_id' })
    if (error) throw new Error(`sde-mirror: station name upsert failed: ${error.message}`)
  })
  console.log(`[sde-mirror] station names: ${rows.length} resolved`)
}

// ── Finalize ────────────────────────────────────────────────────────────────

export const finalizeBuild = async (build) => {
  const { error: refreshError } = await sudoSupabase.rpc('sde_refresh_views')
  if (refreshError) throw new Error(`sde-mirror: sde_refresh_views failed: ${refreshError.message}`)
  const { error } = await sudoSupabase
    .from('sde_mirror_state')
    .update({ completed_at: new Date().toISOString() })
    .eq('build_number', build)
  if (error) throw new Error(`sde-mirror: mirror_state completion failed: ${error.message}`)
  console.log(`[sde-mirror] build ${build} complete`)
}

// ── Whole-run orchestration (CLI / unbounded contexts) ──────────────────────
// The Vercel Workflow (src/workflows/sdeMirror.ts) drives the same building
// blocks step by step instead of calling this.

export const runSdeMirror = async ({ force = false } = {}) => {
  const { build, zipUrl } = await fetchLatestBuild()
  if (!force && (await shouldSkip(build))) {
    console.log(`[sde-mirror] build ${build} already mirrored, skipping (--force to re-ingest)`)
    return { skipped: true, build }
  }
  await markBuildStarted(build)
  const files = await listEntries(zipUrl)
  await forEachSequential(files, (file) => ingestEntrySlice(zipUrl, file, build, 0, Infinity))
  await resolveStationNames()
  await finalizeBuild(build)
  return { skipped: false, build, files: files.length }
}

cli(import.meta.url, 'sde-mirror', async () => {
  const force = process.argv.includes('--force')
  const runId = randomInt(1, 2 ** 48)
  await recordHeartbeat('sde-mirror', 'start', { runId })
  try {
    await runSdeMirror({ force })
  } finally {
    await recordHeartbeat('sde-mirror', 'end', { runId })
  }
})
