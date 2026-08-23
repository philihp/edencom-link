// Unit coverage for the location filter's name matching
// (src/app/api/graphql/structureMatch.ts): the shape a structure name has in
// game against the shape a person types. The refusals matter as much as the
// matches — an ambiguous system or a tie between two structures must resolve to
// nothing rather than to a guess, since the answer becomes a saved link.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MIN_SYSTEM_PREFIX,
  normalizeIdent,
  pickLocation,
  pickStructure,
  pickSystem,
  scoreName,
  systemPrefixPattern,
  tokenize,
} from '../src/app/api/graphql/structureMatch.ts'

const TKDLH = { id: '30000001', name: 'TK-DLH' }
const TKDAB = { id: '30000002', name: 'TK-DAB' }
const JITA = { id: '30000142', name: 'Jita' }

const REACTIONS = { id: '1000000000001', name: 'TK-DLH - CUDDLES T2 Composite Reactions' }
const REPROCESSING = { id: '1000000000002', name: 'TK-DLH - CUDDLES T2 Reprocessing' }

test('normalizeIdent drops the punctuation neither side types reliably', () => {
  assert.equal(normalizeIdent('TK-DLH'), 'TKDLH')
  assert.equal(normalizeIdent('tk d lh'), 'TKDLH')
  assert.equal(normalizeIdent('-'), '')
})

test('tokenize splits on spaces and drops punctuation-only tokens', () => {
  assert.deepEqual(tokenize('TK-DLH - CUDDLES T2 Composite Reactions'), [
    'TK-DLH',
    'CUDDLES',
    'T2',
    'Composite',
    'Reactions',
  ])
  assert.deepEqual(tokenize('   '), [])
})

test('systemPrefixPattern asks the database for a superset, punctuation-blind', () => {
  assert.equal(systemPrefixPattern('TKD'), 'T%K%D%')
  assert.equal(systemPrefixPattern('TK-DLH'), 'T%K%D%')
  assert.equal(systemPrefixPattern('Ji'), 'J%I%')
})

test('pickSystem matches a prefix, hyphen or not', () => {
  assert.deepEqual(pickSystem('TKD', [TKDLH]), { kind: 'match', ref: TKDLH })
  assert.deepEqual(pickSystem('TK-D', [TKDLH]), { kind: 'match', ref: TKDLH })
  assert.deepEqual(pickSystem('tkdlh', [TKDLH]), { kind: 'match', ref: TKDLH })
  assert.deepEqual(pickSystem('Jita', [JITA]), { kind: 'match', ref: JITA })
})

test('pickSystem refuses when two systems share the prefix', () => {
  assert.deepEqual(pickSystem('TKD', [TKDLH, TKDAB]), { kind: 'ambiguous', names: ['TK-DLH', 'TK-DAB'] })
})

test('pickSystem quietly corrects a wrong tail by shortening the prefix', () => {
  // TKDLS matches nothing; TKDL matches TK-DLH alone.
  assert.deepEqual(pickSystem('TK-DLS', [TKDLH]), { kind: 'match', ref: TKDLH })
  // ...but only while the shortened prefix still names one system.
  assert.deepEqual(pickSystem('TK-DLS', [TKDLH, { id: '3', name: 'TK-DLQ' }]), {
    kind: 'ambiguous',
    names: ['TK-DLH', 'TK-DLQ'],
  })
})

test('pickSystem stops shortening at MIN_SYSTEM_PREFIX', () => {
  assert.equal(MIN_SYSTEM_PREFIX, 3)
  // "TZ" is nobody's prefix here and there's nothing left to shorten to.
  assert.deepEqual(pickSystem('TZ', [TKDLH]), { kind: 'none' })
  assert.deepEqual(pickSystem('QQQZZ', [TKDLH]), { kind: 'none' })
})

test('scoreName counts each query token once, by word prefix', () => {
  assert.equal(scoreName(['Reactions'], REACTIONS.name), 1)
  assert.equal(scoreName(['Reactions', 'T2'], REACTIONS.name), 2)
  assert.equal(scoreName(['Compo'], REACTIONS.name), 1)
  assert.equal(scoreName(['CUDDLES', 'CUDDLES'], REACTIONS.name), 2)
  assert.equal(scoreName(['Refinery'], REACTIONS.name), 0)
})

test('pickStructure takes the structure matching the most tokens', () => {
  const structures = [REACTIONS, REPROCESSING]
  assert.deepEqual(pickStructure(['Reactions'], structures), { kind: 'match', ref: REACTIONS })
  assert.deepEqual(pickStructure(['Reactions', 'T2'], structures), { kind: 'match', ref: REACTIONS })
  assert.deepEqual(pickStructure(['Reprocessing'], structures), { kind: 'match', ref: REPROCESSING })
})

test('pickStructure scores the whole name a person pasted', () => {
  assert.deepEqual(pickStructure(tokenize('- CUDDLES T2 Composite Reactions'), [REACTIONS, REPROCESSING]), {
    kind: 'match',
    ref: REACTIONS,
  })
})

test('pickStructure refuses a tie and refuses matching nothing', () => {
  // Both structures account for CUDDLES and T2 and nothing else.
  assert.deepEqual(pickStructure(['CUDDLES', 'T2'], [REACTIONS, REPROCESSING]), {
    kind: 'ambiguous',
    names: [REACTIONS.name, REPROCESSING.name],
  })
  assert.deepEqual(pickStructure(['Refinery'], [REACTIONS, REPROCESSING]), { kind: 'none' })
  assert.deepEqual(pickStructure([], [REACTIONS]), { kind: 'none' })
})

test('pickLocation falls back to the system when no tokens follow it', () => {
  assert.deepEqual(pickLocation([], TKDLH, [REACTIONS]), TKDLH)
  assert.deepEqual(pickLocation(['Reactions'], TKDLH, [REACTIONS, REPROCESSING]), REACTIONS)
  assert.equal(pickLocation(['Refinery'], TKDLH, [REACTIONS, REPROCESSING]), null)
})
