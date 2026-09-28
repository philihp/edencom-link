// The start stagger for the per-character workflows, in workflow context.
// These helpers run in the workflow body, not in a step: Date.now() there is the
// workflow's logical clock (the same value on every replay), and sleep()
// suspends the run on a timer without holding an invocation.
//
// Only the scheduled path is staggered. The cron routes start a workflow with no
// target. The on-demand "Refresh ESI" path gives an OnDemandTarget, and a
// person who clicked a button expects the refresh to start now.

import { always } from 'ramda'
import { sleep } from 'workflow'

import type { OnDemandTarget } from './lib'
import { staggeredStartMs } from './staggerDelay'

// registration id → epoch ms at which that character's step may start.
export const startTimes = (target: OnDemandTarget | undefined, nowMs: number): ((id: string) => number) =>
  target === undefined ? staggeredStartMs(nowMs) : always(nowMs)

// Suspend until startMs. A time already past (a lane that ran late behind a slow
// lane-mate) does not sleep at all.
export const waitUntil = (startMs: number): Promise<void> =>
  startMs > Date.now() ? sleep(new Date(startMs)) : Promise.resolve()
