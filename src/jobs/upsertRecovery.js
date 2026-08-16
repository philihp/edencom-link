// The recovery decision for a failed sde-mirror chunk upsert, split out from
// the I/O so it's unit-testable (the codebase's pure-seam pattern). PostgREST
// schema-cache misses (PGRST205) never reach this — writeWithSchemaRetry
// handles those first — so the inputs here are Postgres/network errors.
//
// A statement timeout (57014) is sized-shaped, not luck-shaped: replaying the
// identical 500-row jsonb statement times out the same way (exactly what the
// workflow's bounded step retries did to the 2026-08-15 run). So the answer to
// a timeout is to bisect the chunk while it's still big enough to matter; only
// once it's down to MIN_BISECT_ROWS does a timeout mean "slow database", where
// waiting and retrying is all that's left.

export const MIN_BISECT_ROWS = 32
export const RETRY_BACKOFF_MS = [1000, 2000, 4000]
// Shared across bisects and retries, so a persistently sick table fails the
// file loudly instead of grinding through the step budget forever.
export const MAX_ATTEMPTS = 6

const STATEMENT_TIMEOUT_CODE = '57014'
// Connection-class SQLSTATEs (08xxx) plus admin shutdown/crash — the server
// went away mid-statement; the row payload is blameless.
const CONNECTION_CODE_RE = /^08|^57P0[123]$/
const NETWORK_MESSAGE_RE = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket|network|timeout/i

const isStatementTimeout = (error) =>
  error?.code === STATEMENT_TIMEOUT_CODE || /statement timeout/i.test(error?.message ?? '')

const isTransient = (error) =>
  (error?.code != null && CONNECTION_CODE_RE.test(String(error.code))) ||
  (error?.code == null && NETWORK_MESSAGE_RE.test(error?.message ?? '')) ||
  /^5\d\d$/.test(String(error?.status ?? ''))

// → { action: 'bisect' } | { action: 'retry', waitMs } | { action: 'fail' }
export const planUpsertRecovery = (error, rowCount, attempt) => {
  if (attempt >= MAX_ATTEMPTS) return { action: 'fail' }
  const waitMs = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]
  if (isStatementTimeout(error)) {
    return rowCount > MIN_BISECT_ROWS ? { action: 'bisect' } : { action: 'retry', waitMs }
  }
  if (isTransient(error)) return { action: 'retry', waitMs }
  return { action: 'fail' }
}
