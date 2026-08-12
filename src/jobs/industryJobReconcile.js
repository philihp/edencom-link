import { forEach, reduce } from 'ramda'

// The pure classification seam shared by character-industry-jobs and
// corp-industry-jobs. Both reconcile an ESI job listing against the open
// (is_current) rows of their SCD-2 table, and both got the vanished-row rule
// wrong in the same way, so the rule lives here once and is unit-tested in
// test/industryJobReconcile.test.ts.

// A job that reached one of these is finished: ESI will never report it in a
// new state, so its row is history and stays is_current forever. Anything else
// is a state the job can still advance out of.
export const TERMINAL_STATUSES = new Set(['delivered', 'cancelled', 'reverted'])

// The tracked attributes that define a version of an industry-job row: the
// state that advances over a job's life. The immutable fields (installer,
// facility, blueprint, runs, dates, cost, ...) are fixed at creation, so only
// these need to be compared. Timestamps are normalized to epoch millis so a
// value ESI serializes with a trailing Z compares equal to the same instant
// Postgres returns with a +00:00 offset (otherwise every run would churn a
// completed job into a new version).
const ts = (x) => (x == null ? null : new Date(x).getTime())
export const jobSignature = (j) =>
  JSON.stringify([
    j.status,
    ts(j.pause_date),
    ts(j.completed_date),
    j.completed_character_id == null ? null : Number(j.completed_character_id),
    j.successful_runs ?? null,
  ])

// Classify a complete ESI job listing against the currently-open rows.
//
//   touchIds   rows whose signature is unchanged — extend valid_until
//   closeIds   rows whose state advanced — close, then insert the new version
//   openJobs   fetched jobs needing an insert (advanced, or never seen)
//   agedOutIds rows absent from the listing while still non-terminal — close
//
// `fetched` MUST be a complete listing. The character endpoint returns the
// whole set in one response (no x-pages), and the corp endpoint is drained by
// fetchAllPages, which throws rather than returning a short list — so absence
// from `fetched` is authoritative and not a paging artifact. Never call this
// with a partial response: every missing job would be closed.
//
// On agedOutIds: ESI's include_completed window is bounded by the job's
// *install*, roughly 90 days, not by when it was delivered. A job that runs
// longer than that window (multi-month ME research is the realistic case)
// disappears from the listing before its delivered state is ever observable —
// by us or by anyone else polling this endpoint. Leaving those rows untouched
// pinned them to is_current with a stale `active` that nothing could ever
// supersede, since the only thing that closes a row is seeing the same job_id
// again with a changed signature, and it will never appear again. That is why
// month-old finished research kept rendering on /industry. Terminal rows are
// still left alone, so the view keeps every job we did see finish.
/**
 * @typedef {{ job_id: number, status: string, [column: string]: any }} EsiJob
 * @typedef {EsiJob & { id: number }} JobRow
 *
 * @param {JobRow[]} current
 * @param {EsiJob[]} fetched
 */
export const partitionJobs = (current, fetched) => {
  const currentByJob = new Map(current.map((c) => [Number(c.job_id), c]))
  // ESI could report the same job twice if the set shifts mid-response;
  // collapse to one entry per job so we never queue two inserts.
  const fetchedByJob = new Map(fetched.map((j) => [Number(j.job_id), j]))

  // Built with a plain local accumulator mutated via push to keep the pass O(n)
  // (cf. character-blueprints).
  const acc = reduce(
    (a, j) => {
      const cur = currentByJob.get(Number(j.job_id))
      if (cur && jobSignature(cur) === jobSignature(j)) {
        a.touchIds.push(cur.id)
      } else {
        if (cur) a.closeIds.push(cur.id)
        a.openJobs.push(j)
      }
      return a
    },
    /** @type {{ touchIds: number[], closeIds: number[], openJobs: EsiJob[], agedOutIds: number[] }} */ ({
      touchIds: [],
      closeIds: [],
      openJobs: [],
      agedOutIds: [],
    }),
    [...fetchedByJob.values()]
  )

  forEach((c) => {
    if (!fetchedByJob.has(Number(c.job_id)) && !TERMINAL_STATUSES.has(c.status)) acc.agedOutIds.push(c.id)
  }, current)

  return acc
}
