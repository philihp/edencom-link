// Unit coverage for the GraphQL hangar filter
// (src/app/api/graphql/hangarFlags.ts). The catalog IS the directory for this
// dimension — there is no table of ESI location_flags to resolve against — so
// what matters here is that the words people actually type reach the tokens
// ESI writes, and that a word that reaches nothing is refused rather than
// quietly returning an empty hangar.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  HANGAR_FLAGS,
  excludeFlagsExpression,
  hangarFlagsAreBareWords,
  matchHangarFilter,
  resolveHangarFilters,
} from '../src/app/api/graphql/hangarFlags.ts'

const flagsOf = (result: ReturnType<typeof matchHangarFilter>): string[] => {
  assert.ok(result.ok, `expected a match, got: ${result.ok ? '' : result.message}`)
  assert.notEqual(result.flags, null)
  return [...(result.flags as string[])].sort()
}

test('no hangar argument means no filter at all', () => {
  const result = matchHangarFilter(null, null)
  assert.ok(result.ok)
  assert.equal(result.flags, null)
  // Blank strings and empty lists read the same way as absent.
  const blank = matchHangarFilter('  ', [])
  assert.ok(blank.ok)
  assert.equal(blank.flags, null)
})

test('"Deliveries" reaches BOTH delivery hangars, singular or plural', () => {
  assert.deepEqual(flagsOf(matchHangarFilter('Deliveries', null)), ['CorpDeliveries', 'Deliveries'])
  assert.deepEqual(flagsOf(matchHangarFilter(null, ['Deliveries'])), ['CorpDeliveries', 'Deliveries'])
  // The point of the alias: a caller need not know either token exists.
  assert.deepEqual(flagsOf(matchHangarFilter('delivery hangar', null)), ['CorpDeliveries', 'Deliveries'])
})

test('the singular is a case-insensitive substring, keeping everything it matched', () => {
  assert.deepEqual(flagsOf(matchHangarFilter('deLIVeries', null)), ['CorpDeliveries', 'Deliveries'])
  assert.deepEqual(flagsOf(matchHangarFilter('corp hangar', null)), [
    'CorpSAG1',
    'CorpSAG2',
    'CorpSAG3',
    'CorpSAG4',
    'CorpSAG5',
    'CorpSAG6',
    'CorpSAG7',
  ])
})

test('a corporation division is reachable by number, token or label', () => {
  for (const entry of ['CorpSAG3', 'corp hangar 3', 'division 3', 'Corporation hangar division 3']) {
    assert.deepEqual(flagsOf(matchHangarFilter(null, [entry])), ['CorpSAG3'], entry)
  }
})

test('the plural is exact: a whole token, label or alias, mixed freely', () => {
  assert.deepEqual(flagsOf(matchHangarFilter(null, ['Deliveries', 'CorpSAG1', 'drone bay'])), [
    'CorpDeliveries',
    'CorpSAG1',
    'Deliveries',
    'DroneBay',
  ])
  // Exact means whole: a substring that the singular would match is refused.
  const partial = matchHangarFilter(null, ['deliv'])
  assert.equal(partial.ok, false)
})

test('duplicate entries collapse rather than repeating a flag', () => {
  assert.deepEqual(flagsOf(matchHangarFilter(null, ['Deliveries', 'CorpDeliveries', 'corp deliveries'])), [
    'CorpDeliveries',
    'Deliveries',
  ])
})

test('a hangar that matches nothing is an error naming what is available', () => {
  const typo = matchHangarFilter('delivries', null)
  assert.equal(typo.ok, false)
  assert.ok(!typo.ok && typo.message.includes('delivries'))
  assert.ok(!typo.ok && typo.message.includes('CorpDeliveries'))

  const list = matchHangarFilter(null, ['Deliveries', 'Nowhere'])
  assert.equal(list.ok, false)
  assert.ok(!list.ok && list.message.includes('"Nowhere"'))
})

test('the singular and the plural are mutually exclusive', () => {
  const both = matchHangarFilter('Deliveries', ['CorpSAG1'])
  assert.equal(both.ok, false)
  assert.ok(!both.ok && both.message.includes('hangar'))
})

test('every catalog entry is a distinct ESI token with a label', () => {
  const flags = HANGAR_FLAGS.map((e) => e.flag)
  assert.equal(new Set(flags).size, flags.length, 'flags are unique')
  for (const entry of HANGAR_FLAGS) {
    assert.match(entry.flag, /^[A-Za-z][A-Za-z0-9]*$/, `${entry.flag} is a bare ESI token`)
    assert.ok(entry.label.length > 0, `${entry.flag} has a label`)
  }
  // The four hangars a station-level filter is actually about.
  for (const flag of ['Hangar', 'Deliveries', 'CorpDeliveries', 'CorpSAG1']) {
    assert.ok(flags.includes(flag), `${flag} is in the catalog`)
  }
})

// ── Exclusion ──────────────────────────────────────────────────────────────
// The other way to name the dimension: which hangars to keep OUT. It resolves
// through the same catalog, so what matters here is how it composes with the
// include pair and what it does to a stack that has no hangar at all.

test('excludeHangar resolves through the same catalog as hangar', () => {
  const result = resolveHangarFilters({ excludeHangar: 'deliveries' })
  assert.ok(result.ok)
  assert.equal(result.include, null)
  assert.deepEqual([...(result.exclude as string[])].sort(), ['CorpDeliveries', 'Deliveries'])
})

test('no hangar arguments at all means no clause of either kind', () => {
  const result = resolveHangarFilters({})
  assert.ok(result.ok)
  assert.equal(result.include, null)
  assert.equal(result.exclude, null)
})

test('include and exclude compose into one narrowed include list', () => {
  // "Both delivery hangars, but not the corporation's" — the useful overlap,
  // settled before it reaches the query rather than as two clauses.
  const result = resolveHangarFilters({ hangar: 'deliveries', excludeHangar: 'corp deliveries' })
  assert.ok(result.ok)
  assert.deepEqual(result.include, ['Deliveries'])
  assert.equal(result.exclude, null)
})

test('excluding everything that was included is refused, not silently empty', () => {
  const result = resolveHangarFilters({ hangar: 'Deliveries', excludeHangars: ['Deliveries', 'CorpDeliveries'] })
  assert.ok(!result.ok)
  assert.match(result.message, /also excluded/)
})

test('a refusal names the argument the caller actually passed', () => {
  const both = resolveHangarFilters({ excludeHangar: 'fuel', excludeHangars: ['Cargo'] })
  assert.ok(!both.ok)
  assert.match(both.message, /excludeHangar or excludeHangars/)

  const unknown = resolveHangarFilters({ excludeHangar: 'not a hangar' })
  assert.ok(!unknown.ok)
  assert.match(unknown.message, /No hangar matched/)
})

test('the exclusion expression keeps rows that have no hangar at all', () => {
  // `location_flag NOT IN (…)` is NULL for a null flag, so plain SQL would drop
  // those rows — but a stack with no flag is not in the fuel bay, and excluding
  // the fuel bay must keep it.
  const expression = excludeFlagsExpression(['StructureFuel', 'SpecializedFuelBay'])
  assert.equal(expression, 'location_flag.is.null,location_flag.not.in.(StructureFuel,SpecializedFuelBay)')
})

test('every catalog flag is a bare word, so it is safe to interpolate', () => {
  // excludeFlagsExpression builds one opaque PostgREST string, so a token
  // carrying a comma or a parenthesis could end the list or start another
  // clause. Nothing in the catalog may.
  assert.ok(hangarFlagsAreBareWords())
})
