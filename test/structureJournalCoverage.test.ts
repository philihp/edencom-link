// The rule that decides whether /structure shows a facility tax at all.
//
// foldEiv suppresses its recovered estimate wherever the wallet journal bills
// the charge exactly — otherwise one charge would be counted twice. What counts
// as "billed exactly" used to be read off *ownership*: a structure owned by any
// corporation the account has a character in. That is a different fact from
// being able to read the corporation's journal, and where they came apart the
// tax vanished from the page entirely: no exact row, and no estimate permitted
// to stand in for it.
//
// In production that hid ~624M ISK across three structures owned by a shared
// corporation the account has characters in but no wallet roles for — its
// corp-wallet-journal extract had failed 256 consecutive runs, so the corp had
// no journal rows at all.
import assert from 'node:assert/strict'
import test from 'node:test'

import { journalCoveredStructures } from '../src/app/structure/journalCoverage.ts'

const READABLE = '98000001' // a corp we hold journal rows for
const OPAQUE = '98000002' // our corp, but no token of ours has wallet roles
const LANDLORD = '1344654522' // somebody else's corp entirely

const structureOwner = new Map([
  ['1000000000001', READABLE],
  ['1000000000002', OPAQUE],
  ['1000000000003', LANDLORD],
  // A structure whose owner ESI never resolved for us.
  ['1000000000004', undefined as unknown as string],
])
const onPage = ['1000000000001', '1000000000002', '1000000000003', '1000000000004', '1000000000005']

test('a structure whose owner journal we hold is covered', () => {
  const covered = journalCoveredStructures({
    onPage,
    structureOwner,
    journalCoveredCorps: new Set([READABLE]),
  })
  assert.ok(covered.has('1000000000001'))
})

// The bug, stated as a test. OPAQUE is one of the account's own corporations —
// under the old ownership rule this structure counted as covered, foldEiv
// skipped the estimate, and because the corp has no journal rows nothing else
// could show the charge either.
test('a structure our own corp owns is NOT covered when we hold no journal for it', () => {
  const covered = journalCoveredStructures({
    onPage,
    structureOwner,
    // OPAQUE is deliberately absent: we are members, not accountants.
    journalCoveredCorps: new Set([READABLE]),
  })
  assert.equal(
    covered.has('1000000000002'),
    false,
    'membership in the owning corp must not suppress the estimate on its own'
  )
})

test("somebody else's structure is never covered", () => {
  const covered = journalCoveredStructures({
    onPage,
    structureOwner,
    journalCoveredCorps: new Set([READABLE, OPAQUE]),
  })
  assert.equal(covered.has('1000000000003'), false)
})

// An unresolved owner is exactly the case the estimate exists for, so it must
// never be mistaken for a covered one — including when the covered set happens
// to contain an empty string, which the old `?? ''` fallback could match.
test('a structure with no resolved owner is never covered', () => {
  const covered = journalCoveredStructures({
    onPage,
    structureOwner,
    journalCoveredCorps: new Set([READABLE, '']),
  })
  assert.equal(covered.has('1000000000004'), false, 'an unknown landlord is not a readable one')
  assert.equal(covered.has('1000000000005'), false, 'a structure absent from the owner map is not covered')
})

test('coverage is drawn from the page, not from the owner map', () => {
  const covered = journalCoveredStructures({
    onPage: ['1000000000001'],
    structureOwner,
    journalCoveredCorps: new Set([READABLE, OPAQUE, LANDLORD]),
  })
  assert.deepEqual([...covered], ['1000000000001'])
})

// Nothing readable means nothing suppressed: every tile falls through to the
// estimate, which is the correct posture for an account that can read no corp
// wallet at all.
test('holding no journals covers nothing', () => {
  const covered = journalCoveredStructures({ onPage, structureOwner, journalCoveredCorps: new Set() })
  assert.equal(covered.size, 0)
})
