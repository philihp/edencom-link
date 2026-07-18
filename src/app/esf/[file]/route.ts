import { NextRequest } from 'next/server'

import { sdeSupabase } from '@/utils/supabase/sde'

// Serves the eveship.fit protobuf files from the esf_data table as if they
// were static files (Phase 2 of docs/sde-db-cutover/04-esf-workflow.md). The
// sde-mirror workflow re-encodes these rows after each CCP SDE build, so what
// this route returns refreshes without a redeploy — unlike the build-time
// static files under /esf-data/, which this path replaces (it must live at a
// new path: public/ assets are served ahead of route handlers, so a same-path
// route would be shadowed until the build step is removed in Phase 3).
//
// Cache design: the data changes only when CCP ships an SDE build (every few
// weeks), so the ETag is keyed on sde_build — a patched SDE flips it and every
// cache revalidates its way to the new bytes. Browsers get a modest max-age
// and then revalidate (304s are cheap); Vercel's CDN holds it much longer and
// serves stale while revalidating, so steady-state requests never wait on
// this function or Supabase.

const FILE_NAMES = new Set([
  'types.pb2',
  'groups.pb2',
  'marketGroups.pb2',
  'dogmaAttributes.pb2',
  'dogmaEffects.pb2',
  'typeDogma.pb2',
])

const CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800'

export async function GET(request: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params
  if (!FILE_NAMES.has(file)) return new Response('Not found', { status: 404 })

  const { data: row, error } = await sdeSupabase()
    .from('esf_data')
    .select('data, sde_build, updated_at')
    .eq('name', file)
    .maybeSingle()
  if (error) return new Response(`esf: ${error.message}`, { status: 500 })
  // Empty table = the sde-mirror workflow's encode step hasn't run yet.
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

  const bytes = Buffer.from(row.data, 'base64')
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.length),
    },
  })
}
