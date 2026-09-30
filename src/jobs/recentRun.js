// "Did this unit of work just run?" — the rule that stops a job start cold
// when the same work completed, or is still going, within the last five
// minutes. A scheduled child run landing two minutes after an on-demand run,
// a refresh pressed twice, a corp reached through two alts' tokens: the
// second start writes no heartbeat, refreshes no token, and to the user never
// happened. Pure; the query lives in ranRecently.js. Tested in
// test/recentRun.test.ts.

export const RECENT_RUN_MS = 5 * 60 * 1000

// A heartbeat row as the lookup reads it: when the run started, when it
// ended (null while it is still going), and whether it ended well.
//
// A run counts when it ended ok within the window (a skip is ok too — the
// corp was answered, if only with "not a director"), or when it started
// within the window and has not ended, which is a run in flight. A run that
// ended in failure never counts: it did not do the work, and the next start
// is the retry.
export const recentlyRan = (rows, now, windowMs = RECENT_RUN_MS) =>
  rows.some((row) => {
    const started = Date.parse(row.started_at)
    const ended = row.ended_at == null ? null : Date.parse(row.ended_at)
    if (ended !== null) return row.ok === true && now - ended < windowMs
    return Number.isFinite(started) && now - started < windowMs
  })

// The loops answer `{ ran, skippedRecent }`: how many units of work they did,
// and how many they stopped for having just run. A run that did nothing
// because everything had just run is one the user should not see — the
// on-demand task row for it is removed rather than marked done.
export const ranNothingRecently = (result) =>
  result != null &&
  typeof result === 'object' &&
  result.ran === 0 &&
  typeof result.skippedRecent === 'number' &&
  result.skippedRecent > 0
