// The start delay for one character's scheduled refresh. Pure (no I/O, no Node
// modules), so the per-character workflows can call it in workflow context and
// the unit test can import it directly.
//
// A cron fire used to start every character at once. Now each character waits
// (registration_id − now) mod 3600 seconds. The registration uuid, read as one
// 128-bit number, sets a fixed second of the hour for each character, and the
// delay is the time until that second next comes. Thus all the jobs of one
// character start at the same second of the hour, whichever minute their cron
// fires at, and the characters of an account spread across the hour.
//
// It subtracts the timestamp, not adds it: with (now + id) mod 3600 the start
// second would be (2·now + id) mod 3600, which is different for each job's cron
// minute, so one character's jobs would not start together.

import { sortBy } from 'ramda'

export const STAGGER_WINDOW_SECONDS = 3600

const WINDOW = BigInt(STAGGER_WINDOW_SECONDS)

// The uuid's 32 hex digits as one number.
const uuidValue = (uuid: string) => BigInt(`0x${uuid.replace(/-/g, '')}`)

// Modulo that is never negative (BigInt % keeps the sign of the dividend).
const modWindow = (n: bigint) => ((n % WINDOW) + WINDOW) % WINDOW

// Seconds, in [0, 3600), from nowSeconds until the character's second of the hour.
export const staggerDelaySeconds = (registrationId: string, nowSeconds: number): number =>
  Number(modWindow(uuidValue(registrationId) - BigInt(nowSeconds)))

// The character's slot as an absolute second: the first time its second of the
// hour comes at or after the run's start. Pinned to the run's start rather than
// to whenever a lane gets round to the character, so a slot that passes while a
// lane-mate's step is still running is taken at once rather than an hour later.
export const slotSeconds = (registrationId: string, startSeconds: number): number =>
  startSeconds + staggerDelaySeconds(registrationId, startSeconds)

// The ids in the order their slots come after the run's start. Sorting before
// the round-robin lane assignment gives every lane a run of characters that
// walks the hour forwards, and spreads each stretch of the hour across all the
// lanes. Stable, and a function of the ids and the start alone, so a replay
// derives the same lanes (ramda's sortBy is stable, so equal slots keep the
// enumeration order).
export const bySlot = (registrationIds: readonly string[], startSeconds: number): string[] =>
  sortBy((id: string) => staggerDelaySeconds(id, startSeconds), registrationIds)
