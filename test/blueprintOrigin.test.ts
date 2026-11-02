// Where a blueprint copy came from (src/app/blueprint/item/origin.ts): the
// window, the candidate kinds, the confidence, and the sentence stored.
import assert from 'node:assert/strict'
import test from 'node:test'

import { inferCopyOrigin, originMemory, type OriginJob } from '../src/app/blueprint/item/origin.ts'

const RIFTER_BP = 787
const T2_BP = 11371

const job = (over: Partial<OriginJob> & Pick<OriginJob, 'job_id'>): OriginJob => ({
  activity_id: 5,
  blueprint_type_id: RIFTER_BP,
  product_type_id: null,
  runs: 10,
  licensed_runs: 20,
  status: 'delivered',
  end_date: '2026-10-01T10:00:00Z',
  station_id: 60003760,
  ...over,
})

const DEBUT = '2026-10-01T12:00:00Z'
const base = { typeId: RIFTER_BP, debut: DEBUT, recordStart: '2026-01-01T00:00:00Z', ownerKind: 'character' as const }

test('one copy job in the window is a high-confidence copy', () => {
  const origin = inferCopyOrigin({ ...base, jobs: [job({ job_id: 1 })] })
  assert.deepEqual(origin, {
    kind: 'copied',
    jobId: '1',
    locationId: '60003760',
    deliveredAt: '2026-10-01T10:00:00Z',
    copies: 10,
    licensedRuns: 20,
    confidence: 'high',
    candidates: 1,
  })
})

test('the job must have delivered inside one extract interval before the debut', () => {
  // 6h for a character: a job delivered 7h before is out, one 5h before is in.
  assert.equal(
    inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, end_date: '2026-10-01T05:00:00Z' })] }).kind,
    'unknown'
  )
  assert.equal(
    inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, end_date: '2026-10-01T07:00:00Z' })] }).kind,
    'copied'
  )
  // A corporation's window is a day.
  assert.equal(
    inferCopyOrigin({ ...base, ownerKind: 'corporation', jobs: [job({ job_id: 1, end_date: '2026-09-30T13:00:00Z' })] })
      .kind,
    'copied'
  )
  // A job delivered after the debut cannot have made it.
  assert.equal(
    inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, end_date: '2026-10-01T13:00:00Z' })] }).kind,
    'unknown'
  )
})

test('delivery is when the player took it out, not when the job ended', () => {
  // Ended in the window but delivered after the debut: not this copy.
  assert.equal(
    inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, completed_date: '2026-10-02T00:00:00Z' })] }).kind,
    'unknown'
  )
  // Ended long before, delivered in the window: a candidate.
  assert.equal(
    inferCopyOrigin({
      ...base,
      jobs: [job({ job_id: 1, end_date: '2026-09-20T00:00:00Z', completed_date: '2026-10-01T11:00:00Z' })],
    }).kind,
    'copied'
  )
})

test('several candidates pick the nearest at medium confidence', () => {
  const origin = inferCopyOrigin({
    ...base,
    jobs: [job({ job_id: 1, end_date: '2026-10-01T08:00:00Z' }), job({ job_id: 2, end_date: '2026-10-01T11:00:00Z' })],
  })
  assert.equal(origin.kind, 'copied')
  if (origin.kind !== 'copied') return
  assert.equal(origin.jobId, '2')
  assert.equal(origin.confidence, 'medium')
  assert.equal(origin.candidates, 2)
})

test('an invention job whose product is the type invented it', () => {
  const origin = inferCopyOrigin({
    ...base,
    typeId: T2_BP,
    jobs: [job({ job_id: 1, activity_id: 8, blueprint_type_id: RIFTER_BP, product_type_id: T2_BP, runs: 4 })],
  })
  assert.equal(origin.kind, 'invented')
})

test('other types, other activities, and cancelled jobs are never candidates', () => {
  assert.equal(inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, blueprint_type_id: 999 })] }).kind, 'unknown')
  assert.equal(inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, activity_id: 1 })] }).kind, 'unknown')
  assert.equal(inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, status: 'cancelled' })] }).kind, 'unknown')
})

test('a copy there at the first extract predates the record', () => {
  assert.deepEqual(inferCopyOrigin({ ...base, debut: base.recordStart, jobs: [job({ job_id: 1 })] }), {
    kind: 'predates',
  })
  assert.equal(inferCopyOrigin({ ...base, recordStart: null, jobs: [] }).kind, 'unknown')
})

test('the stored sentence names the job, the place and the day', () => {
  const origin = inferCopyOrigin({ ...base, jobs: [job({ job_id: 1 })] })
  assert.equal(
    originMemory(origin, { typeName: 'Rifter Blueprint', locationName: 'Jita IV - Moon 4' }),
    'I was one of 10 copies, 20 runs each, made from a Rifter Blueprint original in a job that finished at Jita IV - Moon 4 on 2026-10-01.'
  )
  assert.equal(
    originMemory(inferCopyOrigin({ ...base, jobs: [job({ job_id: 1, runs: 1, licensed_runs: null })] }), {
      typeName: null,
      locationName: null,
    }),
    'I was the one copy made from a blueprint original in a job that finished on 2026-10-01.'
  )
})

test('a medium-confidence sentence says so', () => {
  const origin = inferCopyOrigin({ ...base, jobs: [job({ job_id: 1 }), job({ job_id: 2 })] })
  const text = originMemory(origin, { typeName: 'Rifter Blueprint', locationName: null })
  assert.ok(text?.endsWith('2 such jobs finished around then; this was the nearest, so I may be mistaken about which.'))
})

test('nothing is stored for an unknown or pre-record origin', () => {
  assert.equal(originMemory({ kind: 'unknown' }, { typeName: null, locationName: null }), null)
  assert.equal(originMemory({ kind: 'predates' }, { typeName: null, locationName: null }), null)
})
