// The decisions the universe-structures resolve pass has to make, separated
// from the I/O so they can be tested: when a failure means "stop asking about
// this structure for a while", when the whole pass should stand down, and how
// long a stand-down lasts. No I/O; tested in test/structureResolution.test.ts.
//
// Background. The job pools candidate structure ids from every location column
// we already extract and tries each against *every* token carrying the
// read-structures scope, because a structure only needs one character with
// docking access and that is rarely the character whose assets sit there. With
// ~860 candidates and ~77 tokens that is up to ~66,000 ESI calls in one pass —
// and since a failure was never remembered, the same mostly-unresolvable set
// came back every night. The pass ran until Vercel killed the function at 800
// seconds, which recorded nothing at all: a timeout leaves no end heartbeat, so
// /jobs showed the job as never having run while it was in fact running (and
// dying) daily.

// How long a structure nobody could resolve is left alone. Docking access does
// get granted, so this is a pause and not a blacklist — but re-asking 77 tokens
// every 24 hours to be told 403 again is what generated the load.
export const UNRESOLVED_TTL_DAYS = 7

// ESI's error limit is a bucket of ~100 errors per 60s window, reported on every
// response as x-esi-error-limit-remain. Blowing through it earns 420s across the
// whole application, which is why a pass that ignored it poisoned structures
// that would otherwise have resolved. Stand down with room to spare: other jobs
// share this budget.
export const ERROR_LIMIT_FLOOR = 20

// A 403 here is the normal answer for "this character can't dock there", so the
// bucket drains fast and legitimately. That is the cost of the design, not a
// malfunction — the negative cache is what keeps it from recurring nightly.

// Should this failure stop us asking about this structure for a while?
//
// Only when ESI gave a definitive answer *about the structure*: 403 (no docking
// access for this character) or 404 (no such structure, or unreanchored).
// Everything else — 420 rate limiting, 5xx, a network blip — says nothing about
// the structure and must not be cached, or one bad minute would silence a
// structure for a week.
export const isDefinitiveFailure = (error) => error?.status === 403 || error?.status === 404

// Should the pass stop issuing requests? True once ESI is already refusing
// (420) or the error budget is nearly spent. `errorLimitRemain` is null when no
// response carried the header, which is not evidence of trouble — reading a
// missing header as zero would stand the pass down on its first 403 and nothing
// would ever resolve again.
//
// Typed explicitly: inferred from the defaults alone these read as `null`, and
// every numeric call site becomes a type error.
/**
 * @param {{ status?: number | null, errorLimitRemain?: number | null }} [failure]
 * @returns {boolean}
 */
export const shouldStandDown = (failure = {}) => {
  const { status = null, errorLimitRemain = null } = failure
  return status === 420 || (errorLimitRemain != null && errorLimitRemain <= ERROR_LIMIT_FLOOR)
}

// The timestamp before which an unresolved mark has expired and the structure is
// worth another try. Takes `now` so it is pure.
export const unresolvedCutoff = (now = Date.now()) =>
  new Date(now - UNRESOLVED_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
