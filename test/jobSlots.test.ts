import assert from 'node:assert/strict'
import test from 'node:test'

import { countJobSlots, emptyCounts, type CharacterJobRow, type CorpJobRow } from '../src/app/industry/jobSlots.ts'

const NOW = Date.parse('2026-08-11T12:00:00Z')
const LATER = '2026-08-11T18:00:00Z'
const EARLIER = '2026-08-11T06:00:00Z'

const REGISTRATIONS = new Map([
  ['90000001', 'reg-a'],
  ['90000002', 'reg-b'],
])

const characterJob = (over: Partial<CharacterJobRow> = {}): CharacterJobRow => ({
  job_id: 1,
  registration_id: 'reg-a',
  activity_id: 1,
  status: 'active',
  end_date: LATER,
  ...over,
})

const corpJob = (over: Partial<CorpJobRow> = {}): CorpJobRow => ({
  job_id: 2,
  installer_id: 90000001,
  activity_id: 1,
  status: 'active',
  end_date: LATER,
  ...over,
})

test('counts a corp job against the installing character', () => {
  const counts = countJobSlots({
    corpJobs: [corpJob()],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.deepEqual(counts.get('reg-a')?.manufacturing, { running: 1, finished: 0 })
})

test('sums character and corp jobs into one occupancy', () => {
  const counts = countJobSlots({
    characterJobs: [characterJob({ job_id: 10 }), characterJob({ job_id: 11, activity_id: 4 })],
    corpJobs: [corpJob({ job_id: 20 }), corpJob({ job_id: 21, activity_id: 9 })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.deepEqual(counts.get('reg-a'), {
    manufacturing: { running: 2, finished: 0 },
    research: { running: 1, finished: 0 },
    reaction: { running: 1, finished: 0 },
  })
})

test('counts a job listed by both endpoints once', () => {
  const counts = countJobSlots({
    characterJobs: [characterJob({ job_id: 42 })],
    corpJobs: [corpJob({ job_id: 42 })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.deepEqual(counts.get('reg-a')?.manufacturing, { running: 1, finished: 0 })
})

test('drops corp jobs installed by characters we do not track', () => {
  const counts = countJobSlots({
    corpJobs: [corpJob({ installer_id: 90009999 })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.equal(counts.size, 0)
})

test('an elapsed corp job is ready to deliver, not running', () => {
  const counts = countJobSlots({
    corpJobs: [corpJob({ end_date: EARLIER }), corpJob({ job_id: 3, status: 'ready' })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.deepEqual(counts.get('reg-a')?.manufacturing, { running: 0, finished: 2 })
})

test('ignores activities that consume no slot family', () => {
  const counts = countJobSlots({
    characterJobs: [characterJob({ activity_id: 11 })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.equal(counts.size, 0)
})

test('keeps installers apart', () => {
  const counts = countJobSlots({
    corpJobs: [corpJob({ job_id: 1 }), corpJob({ job_id: 2, installer_id: 90000002 })],
    registrationByCharacterId: REGISTRATIONS,
    now: NOW,
  })
  assert.deepEqual(counts.get('reg-a')?.manufacturing, { running: 1, finished: 0 })
  assert.deepEqual(counts.get('reg-b')?.manufacturing, { running: 1, finished: 0 })
})

test('emptyCounts is a fresh object each call', () => {
  const a = emptyCounts()
  a.manufacturing.running = 5
  assert.equal(emptyCounts().manufacturing.running, 0)
})
