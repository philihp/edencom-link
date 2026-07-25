// Unit coverage for the list_blueprints filter/grouping seam.
//
// The point of these tests is that the filters *leave* JavaScript: every one of
// them has to show up as a blueprint_search() parameter, because that function
// is what applies them (and the by-type collapse) in SQL. A regression that
// quietly moved a filter back into a post-fetch .filter() would drop the
// parameter here and fail.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBlueprintParams,
  formatBlueprintRows,
  partitionOwnerIds,
  type BlueprintDetailRow,
  type BlueprintGroupRow,
  type BlueprintSearchPayload,
} from '../src/app/api/mcp/blueprintQuery.ts'

const OWNERS = { characterIds: ['char-a', 'char-b'], corporationIds: ['98000001', '98000002'] }

const NO_FILTERS = { rowLimit: 200 }

const lookups = {
  ownerName: (id: string) => `Owner ${id}`,
  systemName: (id: number) => `System ${id}`,
  locationName: (row: BlueprintDetailRow) => row.location_name,
}

const detail = (over: Partial<BlueprintDetailRow>): BlueprintDetailRow => ({
  type_id: 1001,
  type_name: 'Naglfar Blueprint',
  owner_id: 'char-a',
  owner_kind: 'character',
  kind: 'original',
  material_efficiency: 10,
  time_efficiency: 20,
  runs: null,
  quantity: 1,
  location_id: 60003760,
  location_name: 'Jita IV - Moon 4',
  location_flag: 'Hangar',
  system_id: 30000142,
  ...over,
})

const payload = (over: Partial<BlueprintSearchPayload>): BlueprintSearchPayload => ({
  group: 'none',
  total_stacks: 0,
  total_quantity: 0,
  originals: 0,
  copies: 0,
  distinct_types: 0,
  rows: [],
  ...over,
})

// ── system scoping ────────────────────────────────────────────────────────
test('a resolved solar system travels to SQL as system_ids', () => {
  const params = buildBlueprintParams({ ...NO_FILTERS, systemIds: [30000142] }, OWNERS)
  assert.deepEqual(params.system_ids, [30000142])
})

test('no system argument means no system filter, not an empty one', () => {
  // null is "everywhere"; [] would match nothing, so the distinction matters.
  assert.equal(buildBlueprintParams(NO_FILTERS, OWNERS).system_ids, null)
})

test('owner scoping splits into the character and corporation id arrays', () => {
  const params = buildBlueprintParams({ ...NO_FILTERS, ownerIds: new Set(['char-b']) }, OWNERS)
  assert.deepEqual(params.character_ids, ['char-b'])
  // Empty (not null) so the corp half of the union matches nothing.
  assert.deepEqual(params.corporation_ids, [])
})

test('a corporation-only owner filter excludes every character row', () => {
  const split = partitionOwnerIds(new Set(['98000002']), OWNERS)
  assert.deepEqual(split.character_ids, [])
  assert.deepEqual(split.corporation_ids, [98000002])
})

test('no owner argument leaves both owner filters unset', () => {
  const params = buildBlueprintParams(NO_FILTERS, OWNERS)
  assert.equal(params.character_ids, null)
  assert.equal(params.corporation_ids, null)
})

// ── kind filter ───────────────────────────────────────────────────────────
test('kind travels to SQL as kind_filter', () => {
  assert.equal(buildBlueprintParams({ ...NO_FILTERS, kind: 'copy' }, OWNERS).kind_filter, 'copy')
  assert.equal(buildBlueprintParams({ ...NO_FILTERS, kind: 'original' }, OWNERS).kind_filter, 'original')
})

test('no kind argument means both originals and copies', () => {
  assert.equal(buildBlueprintParams(NO_FILTERS, OWNERS).kind_filter, null)
})

// ── min_me / min_te ───────────────────────────────────────────────────────
test('min_me and min_te travel to SQL as research floors', () => {
  const params = buildBlueprintParams({ ...NO_FILTERS, minMe: 10, minTe: 20 }, OWNERS)
  assert.equal(params.min_me, 10)
  assert.equal(params.min_te, 20)
})

test('a zero research floor is a real filter, not an absent one', () => {
  // `?? null` would turn 0 into null if it were written `||`.
  const params = buildBlueprintParams({ ...NO_FILTERS, minMe: 0, minTe: 0 }, OWNERS)
  assert.equal(params.min_me, 0)
  assert.equal(params.min_te, 0)
})

test('unset research floors are null', () => {
  const params = buildBlueprintParams(NO_FILTERS, OWNERS)
  assert.equal(params.min_me, null)
  assert.equal(params.min_te, null)
})

// ── group = 'type' ────────────────────────────────────────────────────────
test("group 'type' asks SQL to collapse, and defaults to 'none'", () => {
  assert.equal(buildBlueprintParams({ ...NO_FILTERS, group: 'type' }, OWNERS).group_mode, 'type')
  assert.equal(buildBlueprintParams(NO_FILTERS, OWNERS).group_mode, 'none')
})

test("group 'type' renders one collapsed row per blueprint type", () => {
  const group: BlueprintGroupRow = {
    type_id: 1001,
    type_name: 'Naglfar Blueprint',
    stacks: 3,
    quantity: 7,
    originals: 1,
    copies: 2,
    best_material_efficiency: 10,
    best_time_efficiency: 20,
    copy_runs: 45,
    systems: 2,
  }
  const { rows, total, unit } = formatBlueprintRows(
    payload({ group: 'type', total_stacks: 3, distinct_types: 1, rows: [group] }),
    lookups
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    blueprint: 'Naglfar Blueprint',
    stacks: 3,
    quantity: 7,
    originals: 1,
    copies: 2,
    best_material_efficiency: 10,
    best_time_efficiency: 20,
    copy_runs: 45,
    systems: 2,
  })
  // The cap note counts blueprint types once collapsed, not stacks.
  assert.equal(total, 1)
  assert.equal(unit, 'blueprint types')
})

test('a collapsed row omits copy_runs when the type has no copies', () => {
  const { rows } = formatBlueprintRows(
    payload({
      group: 'type',
      distinct_types: 1,
      rows: [
        {
          type_id: 1001,
          type_name: 'Naglfar Blueprint',
          stacks: 1,
          quantity: 1,
          originals: 1,
          copies: 0,
          best_material_efficiency: 10,
          best_time_efficiency: 20,
          copy_runs: 0,
          systems: 1,
        },
      ],
    }),
    lookups
  )
  assert.ok(!('copy_runs' in rows[0]))
})

test('ungrouped mode keeps every stack as its own row', () => {
  const rows = [
    detail({ location_name: 'Jita IV - Moon 4' }),
    detail({ location_name: 'Amarr VIII', system_id: 30002187 }),
  ]
  const formatted = formatBlueprintRows(payload({ total_stacks: 2, distinct_types: 1, rows }), lookups)
  assert.equal(formatted.rows.length, 2)
  assert.equal(formatted.total, 2)
  assert.equal(formatted.unit, 'blueprints')
  assert.deepEqual(
    formatted.rows.map((r) => r.location),
    ['Jita IV - Moon 4', 'Amarr VIII']
  )
})

test('runs are reported for copies and omitted for originals', () => {
  const { rows } = formatBlueprintRows(
    payload({
      total_stacks: 2,
      rows: [detail({ kind: 'copy', runs: 15 }), detail({ kind: 'original', runs: null })],
    }),
    lookups
  )
  assert.equal(rows[0].runs, 15)
  assert.ok(!('runs' in rows[1]))
})

test('a stack with no resolvable system omits the system field', () => {
  const { rows } = formatBlueprintRows(
    payload({ total_stacks: 1, rows: [detail({ system_id: null, location_name: null })] }),
    lookups
  )
  assert.ok(!('system' in rows[0]))
})

// ── JS ↔ SQL parameter parity ─────────────────────────────────────────────
// The RPC is called by name with a parameter object, so a rename on either side
// fails silently at runtime (PostgREST reports "function does not exist").
test('every parameter buildBlueprintParams emits is declared by blueprint_search()', () => {
  const sql = readFileSync(
    join(import.meta.dirname, '..', 'supabase', 'migrations', '20260725000000_blueprint_search.sql'),
    'utf8'
  )
  const signature = sql.slice(
    sql.indexOf('create or replace function public.blueprint_search('),
    sql.indexOf('returns json')
  )
  const params = buildBlueprintParams({ ...NO_FILTERS, ownerIds: new Set(['char-a']) }, OWNERS)
  Object.keys(params).forEach((name) => {
    assert.match(signature, new RegExp(`\\b${name}\\b`), `blueprint_search() declares no "${name}" parameter`)
  })
})
