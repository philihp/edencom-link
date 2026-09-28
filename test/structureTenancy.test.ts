// The tenancy fold behind structure_tenant: which player structures an
// owner's job listing proves open jobs at, and how many.
import assert from 'node:assert/strict'
import test from 'node:test'

import { OPEN_STATUSES, tenancyFromJobs } from '../src/jobs/structureTenancy.js'

const UPWELL_A = 1_030_000_000_001
const UPWELL_B = 1_030_000_000_002
const JITA_4_4 = 60_003_760

const job = (status: string, station_id: number | null, facility_id: number | null = station_id) => ({
  job_id: Math.floor(Math.random() * 1e9),
  status,
  station_id,
  facility_id,
})

test('counts open jobs per player structure', () => {
  const tenancy = tenancyFromJobs([
    job('active', UPWELL_A),
    job('paused', UPWELL_A),
    job('ready', UPWELL_B),
    job('active', UPWELL_B),
    job('active', UPWELL_B),
  ])
  assert.deepEqual([...tenancy.entries()].sort(), [
    [UPWELL_A, 2],
    [UPWELL_B, 3],
  ])
})

test('a finished job does not make a tenant', () => {
  const tenancy = tenancyFromJobs([job('delivered', UPWELL_A), job('cancelled', UPWELL_A), job('reverted', UPWELL_B)])
  assert.equal(tenancy.size, 0)
})

test('an NPC station is not a structure', () => {
  const tenancy = tenancyFromJobs([job('active', JITA_4_4), job('active', UPWELL_A)])
  assert.deepEqual([...tenancy.entries()], [[UPWELL_A, 1]])
})

test('facility_id stands in when station_id is missing', () => {
  const tenancy = tenancyFromJobs([job('active', null, UPWELL_A)])
  assert.deepEqual([...tenancy.entries()], [[UPWELL_A, 1]])
})

test('ids arrive as strings from PostgREST and as numbers from ESI; both key the same structure', () => {
  const tenancy = tenancyFromJobs([job('active', UPWELL_A), { ...job('ready', null), station_id: String(UPWELL_A) }])
  assert.deepEqual([...tenancy.entries()], [[UPWELL_A, 2]])
})

test('the open statuses are exactly the non-terminal ones ESI has', () => {
  assert.deepEqual([...OPEN_STATUSES].sort(), ['active', 'paused', 'ready'])
})

test('an empty listing proves no tenancy', () => {
  assert.equal(tenancyFromJobs([]).size, 0)
})
