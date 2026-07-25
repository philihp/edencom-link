// Unit coverage for the list_structures filter seam (docs/mcp-tools-spec.md §3).
//
// corp_structure needs no RPC — the solar system, name and owner are columns on
// the row — but the filters still have to be pushed into the PostgREST query
// rather than applied to a drained result set. The recorder below stands in for
// the query builder and captures exactly which predicates were sent.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyStructureFilters,
  bestRigBonus,
  CITADEL_GROUP,
  classForGroupId,
  computeMeBonus,
  corporationIdsFor,
  ENGINEERING_COMPLEX_GROUP,
  escapeLike,
  formatStructure,
  matchesServices,
  REFINERY_GROUP,
  rigBonusFromName,
  type StructureRow,
} from '../src/app/api/mcp/structureQuery.ts'

type Call = { method: 'eq' | 'in' | 'ilike'; column: string; value: unknown }

const recorder = () => {
  const calls: Call[] = []
  const query = {
    eq(column: string, value: unknown) {
      calls.push({ method: 'eq', column, value })
      return query
    },
    in(column: string, value: unknown[]) {
      calls.push({ method: 'in', column, value })
      return query
    },
    ilike(column: string, value: string) {
      calls.push({ method: 'ilike', column, value })
      return query
    },
  }
  return { calls, query }
}

const HIGHSEC = { multiplier: 1, band: 'highsec', display: '0.9' }
const NULLSEC = { multiplier: 2.1, band: 'nullsec', display: '-0.1' }

const row = (over: Partial<StructureRow> = {}): StructureRow => ({
  structure_id: 1050603051889,
  corporation_id: 98000001,
  type_id: 35827,
  system_id: 30000832,
  name: 'HDUMP - T1 Research',
  state: 'shield_vulnerable',
  unanchors_at: null,
  services: [
    { name: 'Manufacturing (Standard)', state: 'online' },
    { name: 'Research', state: 'offline' },
  ],
  last_seen_at: '2026-07-25T09:17:00Z',
  ...over,
})

const lookups = {
  ownerName: (id: string) => `Corp ${id}`,
  hullName: (id: number) => (id === 35827 ? 'Sotiyo' : `Type #${id}`),
  hullGroupId: (id: number) => (id === 35827 ? ENGINEERING_COMPLEX_GROUP : CITADEL_GROUP),
  systemName: (id: number) => (id === 30000832 ? '27-HP0' : null),
  security: () => NULLSEC,
  fuelExpires: (id: string) => (id === '1050603051889' ? '2026-08-01T00:00:00Z' : null),
  rigs: () => ['Standup M-Set Equipment Manufacturing Material Efficiency II'],
}

// ── system scoping ────────────────────────────────────────────────────────
test('a resolved solar system becomes an eq predicate on the query', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { systemId: 30000832 })
  assert.deepEqual(calls, [{ method: 'eq', column: 'system_id', value: 30000832 }])
})

test('no filters means no predicates — the query is left untouched', () => {
  const { calls, query } = recorder()
  const result = applyStructureFilters(query, { systemId: null, name: null, corporationIds: null })
  assert.deepEqual(calls, [])
  assert.equal(result, query)
})

// ── name filter ───────────────────────────────────────────────────────────
test('a name substring becomes an ilike predicate', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { name: 'T1 Research' })
  assert.deepEqual(calls, [{ method: 'ilike', column: 'name', value: '%T1 Research%' }])
})

test('LIKE metacharacters in a name are matched literally, not as wildcards', () => {
  assert.equal(escapeLike('100%_pure'), '100\\%\\_pure')
  const { calls, query } = recorder()
  applyStructureFilters(query, { name: '50%' })
  assert.equal(calls[0].value, '%50\\%%')
})

test('a blank name is not a filter', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { name: '   ' })
  assert.deepEqual(calls, [])
})

// ── owner scoping ─────────────────────────────────────────────────────────
test('an owner filter keeps only the corporation ids and sends them as a predicate', () => {
  // The resolved owner set mixes character registration ids with corporation
  // ids; only the latter can match a corp_structure row.
  const corpIds = corporationIdsFor(new Set(['char-a', '98000002']), ['98000001', '98000002'])
  assert.deepEqual(corpIds, [98000002])

  const { calls, query } = recorder()
  applyStructureFilters(query, { corporationIds: corpIds })
  assert.deepEqual(calls, [{ method: 'in', column: 'corporation_id', value: [98000002] }])
})

test('no owner argument leaves the corporation filter unset', () => {
  assert.equal(corporationIdsFor(null, ['98000001']), null)
})

test('every query-side filter composes on the same query', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { systemId: 30000832, name: 'Forge', corporationIds: [98000001] })
  assert.deepEqual(calls, [
    { method: 'eq', column: 'system_id', value: 30000832 },
    { method: 'ilike', column: 'name', value: '%Forge%' },
    { method: 'in', column: 'corporation_id', value: [98000001] },
  ])
})

// ── services filter ───────────────────────────────────────────────────────
test('services match online entries case-insensitively by substring', () => {
  assert.equal(matchesServices(row(), ['manufacturing']), true)
  assert.equal(matchesServices(row(), ['MANUFACTURING']), true)
  // Research is fitted but offline, so it does not count as available.
  assert.equal(matchesServices(row(), ['research']), false)
  assert.equal(matchesServices(row(), ['reprocessing']), false)
})

test('multiple services must all be online', () => {
  const both = row({
    services: [
      { name: 'Manufacturing (Standard)', state: 'online' },
      { name: 'Research', state: 'online' },
    ],
  })
  assert.equal(matchesServices(both, ['manufacturing', 'research']), true)
  assert.equal(matchesServices(row(), ['manufacturing', 'research']), false)
})

test('no services filter matches everything, including a structure with none', () => {
  assert.equal(matchesServices(row(), undefined), true)
  assert.equal(matchesServices(row(), []), true)
  assert.equal(matchesServices(row({ services: null }), undefined), true)
  assert.equal(matchesServices(row({ services: null }), ['manufacturing']), false)
})

// ── hull class and ME bonus ───────────────────────────────────────────────
test('hull groups map to their Upwell class', () => {
  assert.equal(classForGroupId(CITADEL_GROUP), 'citadel')
  assert.equal(classForGroupId(ENGINEERING_COMPLEX_GROUP), 'engineering_complex')
  assert.equal(classForGroupId(REFINERY_GROUP), 'refinery')
  assert.equal(classForGroupId(999), null)
  assert.equal(classForGroupId(null), null)
})

test('rig tier comes from the name suffix, and the strongest ME rig wins', () => {
  assert.equal(rigBonusFromName('Standup M-Set Material Efficiency II'), 0.024)
  assert.equal(rigBonusFromName('Standup M-Set Material Efficiency I'), 0.02)
  assert.equal(bestRigBonus(['Standup M-Set X Material Efficiency I', 'Standup M-Set Y Material Efficiency II']), 0.024)
  // A rig that isn't an ME rig contributes nothing.
  assert.equal(bestRigBonus(['Standup M-Set Time Efficiency II']), 0)
  assert.equal(bestRigBonus([]), 0)
})

test('me_bonus composes the role, rig and security multipliers', () => {
  // Engineering complex (1% role) + T2 ME rig (2.4%) in nullsec (×2.1):
  //   1 - (1 - 0.01) × (1 - 0.024 × 2.1) = 1 - 0.99 × 0.9496 = 0.059896
  const bonus = computeMeBonus(ENGINEERING_COMPLEX_GROUP, 0.024, NULLSEC)
  assert.equal(bonus.activity, 'manufacturing')
  assert.equal(bonus.role_bonus, 0.01)
  assert.equal(bonus.security_multiplier, 2.1)
  assert.equal(bonus.total_reduction, 0.059896)
})

test("a refinery's role bonus applies to reactions, a citadel's to nothing", () => {
  assert.equal(computeMeBonus(REFINERY_GROUP, 0, HIGHSEC).activity, 'reaction')
  assert.equal(computeMeBonus(REFINERY_GROUP, 0, HIGHSEC).role_bonus, 0.01)
  const citadel = computeMeBonus(CITADEL_GROUP, 0, HIGHSEC)
  assert.equal(citadel.role_bonus, 0)
  assert.equal(citadel.total_reduction, 0)
})

test('security scales the rig bonus but never the role bonus', () => {
  assert.equal(computeMeBonus(CITADEL_GROUP, 0.02, HIGHSEC).total_reduction, 0.02)
  assert.equal(computeMeBonus(CITADEL_GROUP, 0.02, NULLSEC).total_reduction, 0.042)
})

// ── row shaping ───────────────────────────────────────────────────────────
test('a structure row reports its id, hull, system, fuel, rigs, services and bonus', () => {
  const out = formatStructure(row(), lookups)
  assert.deepEqual(out, {
    structure_id: '1050603051889',
    name: 'HDUMP - T1 Research',
    owner: 'Corp 98000001',
    type: 'Sotiyo',
    class: 'engineering_complex',
    system: '27-HP0',
    security: '-0.1',
    state: 'shield_vulnerable',
    fuel_expires: '2026-08-01T00:00:00Z',
    services: ['Manufacturing (Standard)'],
    offline_services: ['Research'],
    rigs: ['Standup M-Set Equipment Manufacturing Material Efficiency II'],
    me_bonus: {
      activity: 'manufacturing',
      role_bonus: 0.01,
      rig_bonus: 0.024,
      security_multiplier: 2.1,
      security_band: 'nullsec',
      total_reduction: 0.059896,
    },
    last_seen_at: '2026-07-25T09:17:00Z',
  })
})

test('a structure with every service online reports no offline_services key', () => {
  const out = formatStructure(row({ services: [{ name: 'Reprocessing', state: 'online' }] }), lookups)
  assert.deepEqual(out.services, ['Reprocessing'])
  assert.ok(!('offline_services' in out))
})

test('a structure with no services and no name still renders', () => {
  const out = formatStructure(row({ services: null, name: null }), lookups)
  assert.equal(out.name, 'Structure #1050603051889')
  assert.deepEqual(out.services, [])
})

test('unanchoring is reported only when a timer is running', () => {
  assert.ok(!('unanchors_at' in formatStructure(row(), lookups)))
  assert.equal(
    formatStructure(row({ unanchors_at: '2026-09-01T00:00:00Z' }), lookups).unanchors_at,
    '2026-09-01T00:00:00Z'
  )
})
