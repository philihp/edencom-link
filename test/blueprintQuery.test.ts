// Unit coverage for the list_blueprints filter/grouping seam
// (docs/mcp-tools-spec.md §1).
//
// The point of these tests is that the filters *leave* JavaScript: every one of
// them, plus the collapse and the limit, has to show up as a blueprint_search()
// parameter, because that function is what applies them in SQL. A regression
// that quietly moved a filter back into a post-fetch .filter() — the defect the
// spec is about — would drop the parameter here and fail.
//
// The SQL semantics those parameters drive (what `below_me` actually excludes,
// how the collapse counts) are asserted against a real Postgres in
// test/sql/blueprint_search.sql.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBlueprintParams,
  clampLimit,
  DEFAULT_LIMIT,
  formatBlueprintRows,
  MAX_LIMIT,
  partitionOwnerIds,
  truncationNote,
  type BlueprintDetailRow,
  type BlueprintGroupRow,
  type BlueprintSearchPayload,
} from '../src/app/api/mcp/blueprintQuery.ts'

const OWNERS = { registrationIds: ['char-a', 'char-b'], corporationIds: ['98000001', '98000002'] }

const lookups = {
  ownerName: (id: string) => `Owner ${id}`,
  systemName: (id: number) => `System ${id}`,
  locationName: (row: { location_name: string | null }) => row.location_name,
}

const detail = (over: Partial<BlueprintDetailRow> = {}): BlueprintDetailRow => ({
  type_id: 1001,
  type_name: 'Naglfar Blueprint',
  owner_id: 'char-a',
  owner_kind: 'character',
  kind: 'original',
  material_efficiency: 10,
  time_efficiency: 20,
  runs: -1,
  quantity: 1,
  researchable: true,
  location_id: 60003760,
  location_name: 'Jita IV - Moon 4',
  location_flag: 'Hangar',
  system_id: 30000142,
  ...over,
})

const group = (over: Partial<BlueprintGroupRow> = {}): BlueprintGroupRow => ({
  type_id: 1001,
  type_name: 'Naglfar Blueprint',
  material_efficiency: 2,
  time_efficiency: 4,
  stacks: 3,
  quantity: 3,
  originals: 0,
  copies: 3,
  copy_runs: 50,
  researchable: true,
  location_id: null,
  location_name: null,
  system_id: null,
  ...over,
})

const payload = (over: Partial<BlueprintSearchPayload>): BlueprintSearchPayload => ({
  group: 'none',
  total_stacks: 0,
  total_quantity: 0,
  originals: 0,
  copies: 0,
  distinct_types: 0,
  total_groups: null,
  rows: [],
  ...over,
})

// ── system scoping ────────────────────────────────────────────────────────
test('a resolved solar system travels to SQL as system_ids', () => {
  const params = buildBlueprintParams({ systemIds: [30000832] }, OWNERS)
  assert.deepEqual(params.system_ids, [30000832])
})

test('no system argument means no system filter, not an empty one', () => {
  // null is "everywhere"; [] would match nothing, so the distinction matters.
  assert.equal(buildBlueprintParams({}, OWNERS).system_ids, null)
})

test('a resolved structure travels to SQL as structure_ids', () => {
  assert.deepEqual(buildBlueprintParams({ structureIds: [1050603051889] }, OWNERS).structure_ids, [1050603051889])
  assert.equal(buildBlueprintParams({}, OWNERS).structure_ids, null)
})

test('owner scoping splits into the character and corporation id arrays', () => {
  const params = buildBlueprintParams({ ownerIds: new Set(['char-b']) }, OWNERS)
  assert.deepEqual(params.registration_ids, ['char-b'])
  // Empty (not null) so the corp half of the union matches nothing.
  assert.deepEqual(params.corporation_ids, [])
})

test('a corporation-only owner filter excludes every character row', () => {
  const split = partitionOwnerIds(new Set(['98000002']), OWNERS)
  assert.deepEqual(split.registration_ids, [])
  assert.deepEqual(split.corporation_ids, [98000002])
})

test('no owner argument leaves both owner filters unset', () => {
  const params = buildBlueprintParams({}, OWNERS)
  assert.equal(params.registration_ids, null)
  assert.equal(params.corporation_ids, null)
})

// ── kind filter ───────────────────────────────────────────────────────────
test('kind travels to SQL as kind_filter and defaults to all', () => {
  assert.equal(buildBlueprintParams({ kind: 'copy' }, OWNERS).kind_filter, 'copy')
  assert.equal(buildBlueprintParams({ kind: 'original' }, OWNERS).kind_filter, 'original')
  assert.equal(buildBlueprintParams({ kind: 'all' }, OWNERS).kind_filter, 'all')
  assert.equal(buildBlueprintParams({}, OWNERS).kind_filter, 'all')
})

// ── below_me / below_te ───────────────────────────────────────────────────
test('below_me and below_te travel to SQL as research ceilings', () => {
  const params = buildBlueprintParams({ belowMe: 10, belowTe: 20 }, OWNERS)
  assert.equal(params.below_me, 10)
  assert.equal(params.below_te, 20)
})

test('a zero ceiling is a real filter, not an absent one', () => {
  // `|| null` would silently turn 0 into "no filter".
  const params = buildBlueprintParams({ belowMe: 0, belowTe: 0 }, OWNERS)
  assert.equal(params.below_me, 0)
  assert.equal(params.below_te, 0)
})

test('unset research ceilings are null', () => {
  const params = buildBlueprintParams({}, OWNERS)
  assert.equal(params.below_me, null)
  assert.equal(params.below_te, null)
})

// ── researchable ──────────────────────────────────────────────────────────
test('researchable travels to SQL and is off by default', () => {
  assert.equal(buildBlueprintParams({ researchable: true }, OWNERS).researchable_only, true)
  assert.equal(buildBlueprintParams({}, OWNERS).researchable_only, false)
})

test('a non-researchable row is flagged in the output so 0/0 reads as intentional', () => {
  const { rows } = formatBlueprintRows(
    payload({ total_stacks: 2, rows: [detail({ researchable: false }), detail()] }),
    lookups
  )
  assert.equal(rows[0].researchable, false)
  // Researchable rows stay quiet — the flag is only worth the tokens as a caveat.
  assert.ok(!('researchable' in rows[1]))
})

// ── group ─────────────────────────────────────────────────────────────────
test("group travels to SQL as group_mode and defaults to 'none'", () => {
  assert.equal(buildBlueprintParams({ group: 'type' }, OWNERS).group_mode, 'type')
  assert.equal(buildBlueprintParams({ group: 'type_location' }, OWNERS).group_mode, 'type_location')
  assert.equal(buildBlueprintParams({}, OWNERS).group_mode, 'none')
})

test("group 'type' renders one counted row per (blueprint, ME, TE)", () => {
  const { rows, total, unit } = formatBlueprintRows(
    payload({ group: 'type', total_stacks: 3, distinct_types: 1, total_groups: 1, rows: [group()] }),
    lookups
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0], {
    blueprint: 'Naglfar Blueprint',
    material_efficiency: 2,
    time_efficiency: 4,
    stacks: 3,
    quantity: 3,
    originals: 0,
    copies: 3,
    copy_runs: 50,
  })
  // The cap note counts groups once collapsed, not stacks.
  assert.equal(total, 1)
  assert.equal(unit, 'blueprint groups')
})

test("group 'type_location' keeps the location on each collapsed row", () => {
  const { rows, unit } = formatBlueprintRows(
    payload({
      group: 'type_location',
      total_groups: 1,
      rows: [group({ location_id: 60003760, location_name: 'Jita IV - Moon 4', system_id: 30000142 })],
    }),
    lookups
  )
  assert.equal(rows[0].location, 'Jita IV - Moon 4')
  assert.equal(rows[0].system, 'System 30000142')
  assert.equal(unit, 'blueprint/location groups')
})

test('a collapsed row omits copy_runs when the group holds no copies', () => {
  const { rows } = formatBlueprintRows(
    payload({ group: 'type', total_groups: 1, rows: [group({ copies: 0, originals: 1, copy_runs: 0 })] }),
    lookups
  )
  assert.ok(!('copy_runs' in rows[0]))
})

test('ungrouped mode keeps every stack as its own row', () => {
  const rows = [detail(), detail({ location_name: 'Amarr VIII', system_id: 30002187 })]
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
    payload({ total_stacks: 2, rows: [detail({ kind: 'copy', runs: 15 }), detail({ kind: 'original', runs: -1 })] }),
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

// ── limit ─────────────────────────────────────────────────────────────────
test('limit travels to SQL as row_limit, defaulting to 100 and capping at 500', () => {
  assert.equal(buildBlueprintParams({}, OWNERS).row_limit, DEFAULT_LIMIT)
  assert.equal(DEFAULT_LIMIT, 100)
  assert.equal(buildBlueprintParams({ limit: 250 }, OWNERS).row_limit, 250)
  // Clamped rather than rejected, so an over-large ask still returns something.
  assert.equal(buildBlueprintParams({ limit: 5000 }, OWNERS).row_limit, MAX_LIMIT)
  assert.equal(MAX_LIMIT, 500)
  assert.equal(clampLimit(0), 1)
  assert.equal(clampLimit(undefined), DEFAULT_LIMIT)
})

// ── truncation note ───────────────────────────────────────────────────────
test('a truncated result names the filters and suggests how to narrow', () => {
  const note = truncationNote(10968, 100, 'blueprints', { item: 'blueprint' }, 100)
  assert.ok(note)
  assert.match(note, /Showing 100 of 10968 blueprints/)
  // The old note gave the agent nothing to act on; this one names the applied
  // filter and the unset parameters that would cut the set down.
  assert.match(note, /item=blueprint/)
  assert.match(note, /system to one solar system/)
  assert.match(note, /raise limit \(currently 100, max 500\)/)
})

test("a truncated ungrouped result suggests group='type'", () => {
  assert.match(truncationNote(500, 100, 'blueprints', {}, 100) ?? '', /group='type'/)
  // Already grouped — suggesting it again would be noise.
  assert.doesNotMatch(truncationNote(500, 100, 'blueprint groups', { group: 'type' }, 100) ?? '', /group='type'/)
})

test('an untruncated result gets no note', () => {
  assert.equal(truncationNote(12, 12, 'blueprints', {}, 100), undefined)
})

// ── JS ↔ SQL parameter parity ─────────────────────────────────────────────
// The RPC is called by name with a parameter object, so a rename on either side
// fails silently at runtime (PostgREST reports "function does not exist").
test('every parameter buildBlueprintParams emits is declared by blueprint_search()', () => {
  // Find the newest migration that (re)defines blueprint_search rather than
  // naming one: the function has been redefined twice by the registration_id
  // rename, and each time a hardcoded path here would have gone on asserting
  // against a superseded signature — or, once the definition changed from
  // `create or replace` to `create`, stopped finding it at all.
  const migrations = join(import.meta.dirname, '..', 'supabase', 'migrations')
  const DEFINES = /create (?:or replace )?function public\.blueprint_search\(/
  const newest = readdirSync(migrations)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse()
    .find((f) => DEFINES.test(readFileSync(join(migrations, f), 'utf8')))
  assert.ok(newest, 'no migration defines blueprint_search()')

  const sql = readFileSync(join(migrations, newest), 'utf8')
  const start = sql.search(DEFINES)
  const signature = sql.slice(start, sql.indexOf('returns json', start))
  const params = buildBlueprintParams({ ownerIds: new Set(['char-a']) }, OWNERS)
  Object.keys(params).forEach((name) => {
    assert.match(signature, new RegExp(`\\b${name}\\b`), `blueprint_search() declares no "${name}" parameter`)
  })
})
