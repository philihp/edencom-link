// The start stagger for the scheduled per-character workflows, in workflow
// context. The cron route starts a workflow with no target, and that run starts
// one child run per character with { staggered: true }. Each child calls
// waitForSlot in its workflow body before its lanes start. Date.now() there is
// the workflow's logical clock (the same value on every replay), and sleep()
// suspends the run on a timer without holding an invocation.

import { sleep } from 'workflow'

import { staggerDelaySeconds } from './staggerDelay'

// Suspend until the character's second of the hour. No sleep when that second
// is now.
export const waitForSlot = (registrationId: string): Promise<void> => {
  const delaySeconds = staggerDelaySeconds(registrationId, Math.floor(Date.now() / 1000))
  return delaySeconds > 0 ? sleep(new Date(Date.now() + delaySeconds * 1000)) : Promise.resolve()
}
