// Unit coverage for the phrase the Link directory prints in its "Issued to"
// column. The listing is now the only place an owner sees a Link's audience
// without opening it, so a wrong label here is a privacy tell: reading "Not
// issued" over a Link that is in fact public is the failure that matters.
//
// The distinctions are the Revision 3 ones (docs/sharing-layer/01-asset-share-table.md):
// `enabled` separates "not issued yet" from "issued to everyone", and audiences
// compose, so corporations and a signed link can both be true at once.
import assert from 'node:assert/strict'
import test from 'node:test'

import { issuanceLabel } from '../src/app/link/issuance.ts'

const row = (over: Partial<Parameters<typeof issuanceLabel>[0]> = {}) => ({
  enabled: true,
  corporation_ids: [],
  alliance_ids: [],
  secret: null,
  ...over,
})

test('a disabled link is not issued, whatever its audience columns say', () => {
  assert.equal(issuanceLabel(row({ enabled: false })), 'Not issued')
  // The audience survives a withdrawal in the row; the label must not.
  assert.equal(issuanceLabel(row({ enabled: false, corporation_ids: [98000001], secret: 'abc' })), 'Not issued')
})

test('enabled with no audience at all is the public state', () => {
  assert.equal(issuanceLabel(row()), 'Everyone')
})

test('a secret alone is a signed link, not public', () => {
  assert.equal(issuanceLabel(row({ secret: 'abc' })), 'signed link')
})

test('counts are pluralized per audience kind', () => {
  assert.equal(issuanceLabel(row({ corporation_ids: [1] })), '1 corporation')
  assert.equal(issuanceLabel(row({ corporation_ids: [1, 2] })), '2 corporations')
  assert.equal(issuanceLabel(row({ alliance_ids: [1] })), '1 alliance')
  assert.equal(issuanceLabel(row({ alliance_ids: [1, 2] })), '2 alliances')
})

test('audiences compose rather than winning over each other', () => {
  assert.equal(
    issuanceLabel(row({ corporation_ids: [1, 2], alliance_ids: [3], secret: 'abc' })),
    '2 corporations · 1 alliance · signed link'
  )
})

test('null audience columns read as empty, not as a crash', () => {
  assert.equal(issuanceLabel(row({ corporation_ids: null, alliance_ids: null })), 'Everyone')
  assert.equal(issuanceLabel(row({ corporation_ids: null, alliance_ids: null, secret: 'abc' })), 'signed link')
})
