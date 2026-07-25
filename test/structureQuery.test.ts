// Unit coverage for the list_structures filter seam.
//
// corp_structure needs no RPC — the solar system and hull type are columns on
// the row — but the filters still have to be pushed into the PostgREST query
// rather than applied to a drained result set. The recorder below stands in for
// the query builder and captures exactly which predicates were sent.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyStructureFilters,
  corporationIdsFor,
  formatStructure,
  groupIdForKind,
  kindForGroupId,
  STRUCTURE_KIND_GROUPS,
  STRUCTURE_KINDS,
  type StructureRow,
} from '../src/app/api/mcp/structureQuery.ts'

type Call = { method: 'eq' | 'in'; column: string; value: unknown }

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
  }
  return { calls, query }
}

const row = (over: Partial<StructureRow> = {}): StructureRow => ({
  structure_id: 1050603051889,
  corporation_id: 98000001,
  type_id: 35836,
  system_id: 30000142,
  name: 'Jita - Trade Hub',
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
  hullName: (id: number) => (id === 35836 ? 'Astrahus' : `Type #${id}`),
  hullGroupId: (id: number) => (id === 35836 ? 1657 : 1404),
  systemName: (id: number) => (id === 30000142 ? 'Jita' : null),
  security: (id: number) => (id === 30000142 ? '0.9' : null),
  fuelExpires: (id: string) => (id === '1050603051889' ? '2026-08-01T00:00:00Z' : null),
}

// ── system scoping ────────────────────────────────────────────────────────
test('a resolved solar system becomes an eq predicate on the query', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { systemId: 30000142 })
  assert.deepEqual(calls, [{ method: 'eq', column: 'system_id', value: 30000142 }])
})

test('no filters means no predicates — the query is left untouched', () => {
  const { calls, query } = recorder()
  const result = applyStructureFilters(query, { systemId: null, typeIds: null })
  assert.deepEqual(calls, [])
  assert.equal(result, query)
})

// ── kind filter ───────────────────────────────────────────────────────────
test('a hull class becomes an in predicate on type_id', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { typeIds: [35825, 35826] })
  assert.deepEqual(calls, [{ method: 'in', column: 'type_id', value: [35825, 35826] }])
})

test('a hull class that resolved to no types filters everything out rather than widening', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { typeIds: [] })
  assert.deepEqual(calls, [{ method: 'in', column: 'type_id', value: [] }])
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
  const { calls, query } = recorder()
  applyStructureFilters(query, { corporationIds: null })
  assert.deepEqual(calls, [])
})

test('every filter composes on the same query', () => {
  const { calls, query } = recorder()
  applyStructureFilters(query, { systemId: 30000142, typeIds: [35825], corporationIds: [98000001] })
  assert.deepEqual(calls, [
    { method: 'eq', column: 'system_id', value: 30000142 },
    { method: 'in', column: 'type_id', value: [35825] },
    { method: 'in', column: 'corporation_id', value: [98000001] },
  ])
})

test('each kind maps to its Upwell hull group, and back', () => {
  assert.deepEqual(STRUCTURE_KINDS, ['citadel', 'engineering_complex', 'refinery'])
  assert.equal(groupIdForKind('refinery'), 1406)
  assert.equal(groupIdForKind('engineering_complex'), 1404)
  assert.equal(groupIdForKind('citadel'), 1657)
  STRUCTURE_KINDS.forEach((kind) => assert.equal(kindForGroupId(STRUCTURE_KIND_GROUPS[kind]), kind))
  assert.equal(kindForGroupId(999), null)
  assert.equal(kindForGroupId(null), null)
})

// ── row shaping ───────────────────────────────────────────────────────────
test('a structure row reports its id, hull, kind, system, fuel and service split', () => {
  const out = formatStructure(row(), lookups)
  assert.deepEqual(out, {
    structure_id: '1050603051889',
    name: 'Jita - Trade Hub',
    owner: 'Corp 98000001',
    hull: 'Astrahus',
    kind: 'citadel',
    system: 'Jita',
    security: '0.9',
    state: 'shield_vulnerable',
    fuel_expires: '2026-08-01T00:00:00Z',
    online_services: ['Manufacturing (Standard)'],
    offline_services: ['Research'],
    last_seen_at: '2026-07-25T09:17:00Z',
  })
})

test('a structure with every service online reports no offline_services key', () => {
  const out = formatStructure(row({ services: [{ name: 'Reprocessing', state: 'online' }] }), lookups)
  assert.deepEqual(out.online_services, ['Reprocessing'])
  assert.ok(!('offline_services' in out))
})

test('a structure with no services and no name still renders', () => {
  const out = formatStructure(row({ services: null, name: null }), lookups)
  assert.equal(out.name, 'Structure #1050603051889')
  assert.deepEqual(out.online_services, [])
})

test('unanchoring is reported only when a timer is running', () => {
  assert.ok(!('unanchors_at' in formatStructure(row(), lookups)))
  assert.equal(
    formatStructure(row({ unanchors_at: '2026-09-01T00:00:00Z' }), lookups).unanchors_at,
    '2026-09-01T00:00:00Z'
  )
})
