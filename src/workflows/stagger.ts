// The start stagger for the scheduled per-character workflows, in workflow
// context. The cron route starts a workflow with no target, and that run drains
// its lanes itself: before each character's step the lane calls waitForSlot,
// which sleeps until that character's second of the hour. Date.now() there is
// the workflow's logical clock (the same value on every replay), and sleep()
// suspends the run on a timer without holding an invocation, so a lane spends
// the hour asleep between its characters at the cost of one event per sleep.
// (#1067 first gave each character its own child run that slept before its lane
// started: a dispatch step, a run, a sleep and a step — four events per
// character, not two. Vercel bills per event.)

import { sleep } from 'workflow'

import { slotSeconds } from './staggerDelay'

export { bySlot } from './staggerDelay'

// The run's start in whole seconds, read once at the top of the workflow body.
// Every slot is measured from it.
export const runStartSeconds = (): number => Math.floor(Date.now() / 1000)

// Suspend until the character's slot: its second of the hour, first reached at
// or after the run's start. No sleep when that moment has already come — e.g.
// while a lane-mate's step ran past it — so a late lane catches up instead of
// waiting another hour.
export const waitForSlot = (registrationId: string, startSeconds: number): Promise<void> => {
  const slotMs = slotSeconds(registrationId, startSeconds) * 1000
  return slotMs > Date.now() ? sleep(new Date(slotMs)) : Promise.resolve()
}
