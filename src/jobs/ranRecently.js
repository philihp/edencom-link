// "Did this job just run for this owner?" — the heartbeat lookup behind the
// five-minute rule (recentRun.js holds the pure judgement). Its own module,
// free of Node built-ins, because src/workflows/lib.ts imports it from a
// workflow function body: the workflow compiler follows that import, and a
// module that reaches `node:crypto` or `node:url` fails the build.

import { sudoSupabase } from '../supabase.js'
import { RECENT_RUN_MS, recentlyRan } from './recentRun.js'

// The owner is a character (`{ registrationId }`), a corporation
// (`{ corporationId }`), or the whole job (`{}`). Two indexed reads of the
// heartbeat table (job + ended_at; job + open rows), judged by recentlyRan: a
// run ended ok, or still going, within the last five minutes. A failed read
// answers false — asking ESI again is the safe side.
export const ranRecently = async (tag, { registrationId = null, corporationId = null } = {}) => {
  const now = Date.now()
  const since = new Date(now - RECENT_RUN_MS).toISOString()
  const scope = (query) => {
    if (corporationId != null) return query.eq('corporation_id', corporationId)
    const noCorp = query.is('corporation_id', null)
    return registrationId == null ? noCorp.is('registration_id', null) : noCorp.eq('registration_id', registrationId)
  }
  try {
    const columns = 'started_at, ended_at, ok'
    const [ended, open] = await Promise.all([
      scope(sudoSupabase.from('heartbeat').select(columns).eq('job', tag).gt('ended_at', since)).limit(20),
      scope(
        sudoSupabase.from('heartbeat').select(columns).eq('job', tag).is('ended_at', null).gt('started_at', since)
      ).limit(20),
    ])
    if (ended.error) throw ended.error
    if (open.error) throw open.error
    return recentlyRan([...(ended.data ?? []), ...(open.data ?? [])], now)
  } catch (e) {
    console.warn(`[${tag}] recent-run check unavailable, running: ${e?.message ?? e}`)
    return false
  }
}
