// The invite-code earning schedule, shared by the /account/invite page (to show
// the schedule) and the createInviteCode action (to enforce it).
//
// The clock starts the first time a user adds a character through EVE SSO. The
// n-th invite code (n starting at 1) unlocks (2^n - 1) weeks after that moment:
// 1, 3, 7, 15, 31, … weeks. Put differently, the wait between successive unlocks
// is 1 week, then 2, then 4, then 8 — doubling each time.

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Whole weeks after the first SSO when invite #n becomes available.
export const weeksToUnlock = (n: number) => 2 ** n - 1

// Wall-clock moment invite #n unlocks, given when the clock started.
export const unlockDate = (firstSsoAt: Date, n: number) => new Date(firstSsoAt.getTime() + weeksToUnlock(n) * WEEK_MS)

// How many invite codes the schedule has granted by `now`. Zero until the user
// has added a character (firstSsoAt is null) and for the first week after.
export const earnedCount = (firstSsoAt: Date | null, now: Date = new Date()): number => {
  if (!firstSsoAt) return 0
  const weeks = (now.getTime() - firstSsoAt.getTime()) / WEEK_MS
  if (weeks < 1) return 0
  // Largest n with (2^n - 1) <= weeks  ⇔  floor(log2(weeks + 1)).
  return Math.floor(Math.log2(weeks + 1))
}
