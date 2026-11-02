// Unit coverage for the blueprint dossier fold
// (src/app/ship/memory/blueprintDossier.ts, docs/ship-memory.md "Extension:
// every singleton" → "Blueprint"). The research steps and the run counts are
// what a blueprint's memory is written from, so both are pinned, with the
// at-least rule (delivered jobs only) and the kind read from ESI's quantity.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ACTIVITY,
  type BlueprintJob,
  type BlueprintVersion,
  blueprintDossier,
  blueprintKind,
  blueprintTenures,
  researchSteps,
} from '../src/app/ship/memory/blueprintDossier.ts'
import type { Owner } from '../src/app/ship/memory/dossier.ts'

const HOUR = 60 * 60 * 1000
const T0 = new Date('2026-09-01T00:00:00Z').getTime()
const at = (hours: number): string => new Date(T0 + hours * HOUR).toISOString()

const ALICE: Owner = { kind: 'character', id: 'reg-a' }
const CORP: Owner = { kind: 'corporation', id: '98000001' }
const VEXOR_BPO = 972
const VEXOR = 626
const STATION = 60004588

const version = (over: Partial<BlueprintVersion> = {}): BlueprintVersion => ({
  owner: ALICE,
  typeId: VEXOR_BPO,
  quantity: -1,
  me: 0,
  te: 0,
  runs: -1,
  locationId: STATION,
  locationFlag: 'Hangar',
  isCurrent: false,
  validFrom: at(0),
  validUntil: at(6),
  ...over,
})

const job = (over: Partial<BlueprintJob> = {}): BlueprintJob => ({
  jobId: 1,
  owner: ALICE,
  installerId: 2112000001,
  activityId: ACTIVITY.manufacturing,
  runs: 10,
  licensedRuns: null,
  successfulRuns: null,
  productTypeId: VEXOR,
  facilityId: STATION,
  cost: 1_000_000,
  status: 'delivered',
  startDate: at(1),
  endDate: at(5),
  ...over,
})

test('the kind is read from ESI quantity: -1 an original, -2 a copy, positive a stack', () => {
  assert.equal(blueprintKind(-1), 'original')
  assert.equal(blueprintKind(-2), 'copy')
  assert.equal(blueprintKind(5), 'stack')
  assert.equal(blueprintKind(null), 'unknown')
})

test('research steps are the ME/TE changes between versions, credited to the research job that ended between them', () => {
  const versions = [
    version({ me: 0, te: 0, validFrom: at(0), validUntil: at(6) }),
    version({ me: 0, te: 0, validFrom: at(6), validUntil: at(12) }), // a move, no research
    version({ me: 5, te: 0, validFrom: at(12), validUntil: at(48) }),
    version({ me: 5, te: 10, validFrom: at(48), validUntil: at(60), isCurrent: true }),
  ]
  const jobs = [
    job({ jobId: 11, activityId: ACTIVITY.researchMe, endDate: at(10), runs: 1 }),
    job({ jobId: 12, activityId: ACTIVITY.researchTe, endDate: at(40), runs: 1 }),
    job({ jobId: 13, activityId: ACTIVITY.researchTe, endDate: at(4), runs: 1 }), // ended before the ME step; wrong activity for it
  ]
  assert.deepEqual(researchSteps(versions, jobs), [
    { at: at(12), from: { me: 0, te: 0 }, to: { me: 5, te: 0 }, jobId: 11 },
    { at: at(48), from: { me: 5, te: 0 }, to: { me: 5, te: 10 }, jobId: 12 },
  ])
})

test('a step with no research job on record carries none, rather than borrowing one of the wrong activity', () => {
  const versions = [version({ me: 0 }), version({ me: 10, validFrom: at(6), validUntil: at(12), isCurrent: true })]
  const steps = researchSteps(versions, [job({ jobId: 11, activityId: ACTIVITY.researchTe, endDate: at(3) })])
  assert.deepEqual(steps, [{ at: at(6), from: { me: 0, te: 0 }, to: { me: 10, te: 0 }, jobId: null }])
})

test('the nearest fitting job wins when two research jobs of the activity ended between two sightings', () => {
  const versions = [version({ me: 0 }), version({ me: 2, validFrom: at(24), validUntil: at(30), isCurrent: true })]
  const steps = researchSteps(versions, [
    job({ jobId: 11, activityId: ACTIVITY.researchMe, endDate: at(5) }),
    job({ jobId: 12, activityId: ACTIVITY.researchMe, endDate: at(20) }),
  ])
  assert.equal(steps[0]?.jobId, 12)
})

test('tenures collapse consecutive versions under one owner, and a hangar move keeps the id', () => {
  const versions = [
    version({ owner: ALICE, validFrom: at(0), validUntil: at(6) }),
    version({ owner: ALICE, validFrom: at(6), validUntil: at(12) }),
    version({ owner: CORP, validFrom: at(12), validUntil: at(18), isCurrent: true }),
  ]
  assert.deepEqual(blueprintTenures(versions), [
    { owner: ALICE, from: at(0), until: at(12) },
    { owner: CORP, from: at(12), until: null },
  ])
})

test('the Vexor question: runs over delivered manufacturing jobs, by product, facility and installer', () => {
  const d = blueprintDossier({
    itemId: 1011382969076,
    versions: [version({ me: 10, te: 20, isCurrent: true })],
    jobs: [
      job({ jobId: 1, runs: 300 }),
      job({ jobId: 2, runs: 247, facilityId: 1035000000001, installerId: 2112000002 }),
      job({ jobId: 3, runs: 50, status: 'active', endDate: at(100) }), // not delivered yet: counted as a job, not in runs
      job({ jobId: 4, runs: 99, status: 'cancelled' }), // never counts
      job({ jobId: 5, activityId: ACTIVITY.copying, runs: 3, licensedRuns: 10 }),
      job({ jobId: 6, activityId: ACTIVITY.researchMe, runs: 1 }),
    ],
    lastSeen: at(120),
  })
  assert.ok(d)
  assert.equal(d.kind, 'original')
  assert.deepEqual(d.research.current, { me: 10, te: 20 })
  assert.equal(d.building.jobs, 3)
  assert.equal(d.building.delivered, 2)
  assert.equal(d.building.runsAtLeast, 547)
  assert.equal(d.building.costAtLeast, 2_000_000)
  assert.deepEqual(d.building.byProduct, [{ productTypeId: VEXOR, jobs: 3, runsAtLeast: 547 }])
  assert.deepEqual(
    d.building.facilities.map((f) => f.jobs),
    [2, 1]
  )
  assert.deepEqual(
    d.building.installers.map((i) => i.jobs),
    [2, 1]
  )
  assert.equal(d.copying.runsAtLeast, 3)
  assert.equal(d.copying.licensedRunsAtLeast, 30)
  assert.equal(d.researchJobs.me, 1)
  assert.equal(d.researchJobs.te, 0)
  assert.equal(d.runsRemaining, null)
  assert.equal(d.inHangar, true)
})

test('a copy reports its runs remaining; install cost is null as soon as one delivered job has none', () => {
  const d = blueprintDossier({
    itemId: 7,
    versions: [version({ quantity: -2, runs: 4, isCurrent: true })],
    jobs: [job({ jobId: 1, cost: null }), job({ jobId: 2 })],
    lastSeen: at(10),
  })
  assert.equal(d?.kind, 'copy')
  assert.equal(d?.runsRemaining, 4)
  assert.equal(d?.building.costAtLeast, null)
})

test('no versions means nothing to remember', () => {
  assert.equal(blueprintDossier({ itemId: 1, versions: [], jobs: [job()], lastSeen: at(1) }), null)
})
