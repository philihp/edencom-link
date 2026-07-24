import { NextRequest } from 'next/server'

import { SHEET_FILE_NAMES } from '@/buildSheetCsv.js'
import { sdeSupabase } from '@/utils/supabase/sde'

// Serves the industry spreadsheet's static CSVs from the sheet_csv table for
// Google Sheets =IMPORTDATA(). Structurally a copy of /esf/[file]: allowlisted
// filename, ETag keyed on sde_build, conditional-request handling, long CDN
// cache — but the body is text/csv rather than binary, and there's no api_token
// (the data is derived purely from CCP's public SDE, contains no player data,
// and is identical for every caller, so unlike /api/character/* it can be public
// and aggressively CDN-cached). The sde-mirror workflow re-encodes these rows
// after each SDE build, so what this returns refreshes without a redeploy.
//
// Cache design (same as /esf/[file]): the data changes only when CCP ships an
// SDE build, so the ETag is keyed on sde_build. Browsers get a modest max-age
// then revalidate (304s are cheap); Vercel's CDN holds it much longer and serves
// stale while revalidating, so steady-state requests never wait on this function
// or Supabase. (Google's IMPORTDATA fetcher caches on its own ~1h schedule
// regardless, which is fine at this change cadence.)

const FILE_NAMES = new Set<string>(SHEET_FILE_NAMES)

const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

export async function GET(request: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params
  if (!FILE_NAMES.has(file)) return new Response('Not found', { status: 404 })

  const { data: row, error } = await sdeSupabase()
    .from('sheet_csv')
    .select('data, sde_build, updated_at')
    .eq('name', file)
    .maybeSingle()
  if (error) return new Response(`sheet-csv: ${error.message}`, { status: 500 })
  // Empty table = the sde-mirror workflow's encodeSheets step hasn't run yet.
  if (!row) return new Response('Not found', { status: 404 })

  const etag = `"${row.sde_build}-${file}"`
  // HTTP dates carry second precision, so truncate before comparing against
  // If-Modified-Since — otherwise our sub-second timestamp always looks newer.
  const lastModified = new Date(Math.floor(new Date(row.updated_at).getTime() / 1000) * 1000)
  const headers: Record<string, string> = {
    ETag: etag,
    'Last-Modified': lastModified.toUTCString(),
    'Cache-Control': CACHE_CONTROL,
  }

  const ifNoneMatch = request.headers.get('if-none-match')
  const ifModifiedSince = request.headers.get('if-modified-since')
  const notModified = ifNoneMatch
    ? ifNoneMatch.split(',').some((tag) => tag.trim() === etag)
    : ifModifiedSince
      ? new Date(ifModifiedSince).getTime() >= lastModified.getTime()
      : false
  if (notModified) return new Response(null, { status: 304, headers })

  const bytes = Buffer.from(row.data, 'utf8')
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': String(bytes.length),
    },
  })
}
