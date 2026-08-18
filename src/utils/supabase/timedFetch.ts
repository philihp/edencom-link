import { isCollectingServerTiming, recordServerTimingSpan } from '@/serverTiming'

// The `global.fetch` every Supabase client factory here installs, so that each
// PostgREST/GoTrue round trip becomes one Server-Timing span without a single
// call site changing (src/serverTiming.ts). supabase-js routes every request
// through this one function, which makes it the only place that sees both the
// URL (i.e. *which* query) and the wall clock.
//
// Outside a collection scope — a page render, a cron job, a workflow step —
// this is the platform fetch plus one AsyncLocalStorage lookup.

// `db.character_asset_snapshot_at` (an RPC), `db.character_asset` (a table),
// `auth.user` (a session check). The label separates the SDE mirror's public
// anon client from the caller-scoped ones, because "the static data was slow"
// and "this player's hangar was slow" are different problems.
const spanNameFor = (label: string, url: string): string => {
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return ''
    }
  })()
  const rpc = path.match(/\/rest\/v\d+\/rpc\/([^/?]+)/)
  if (rpc) return `${label}.${rpc[1]}`
  const rest = path.match(/\/rest\/v\d+\/([^/?]+)/)
  if (rest) return `${label}.${rest[1]}`
  const auth = path.match(/\/auth\/v\d+\/(.+)/)
  if (auth) return `auth.${auth[1]}`
  return label
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

export const timedSupabaseFetch =
  (label: string): typeof fetch =>
  async (input, init) => {
    if (!isCollectingServerTiming()) return fetch(input, init)
    const startedAt = performance.now()
    try {
      return await fetch(input, init)
    } finally {
      // Recorded in `finally` so a timed-out or refused query — the slowest
      // thing a request can do — still shows up in the header.
      recordServerTimingSpan(spanNameFor(label, urlOf(input)), performance.now() - startedAt)
    }
  }
