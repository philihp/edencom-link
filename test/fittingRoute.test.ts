// Unit coverage for the /fitting/[characterId]/[fittingId] route builder
// (src/app/fitting/fit.ts). Trivial, but it's the one seam every fitting link
// on the site goes through (the list matrix, the MCP list_fittings tool), so
// pinning its exact shape catches a stray typo before it 404s a real link.
import assert from 'node:assert/strict'
import test from 'node:test'

import { fittingRoute } from '../src/app/fitting/fit.ts'

test('fittingRoute builds the two-segment path', () => {
  // The first segment is the owner's EVE numeric character id, never the
  // registration uuid the fitting tables key on — resolveCharacter.ts
  // translates between the two at the route boundary.
  assert.equal(fittingRoute(2117551513, 42), '/fitting/2117551513/42')
  // Both ids can arrive as strings (PostgREST renders bigint that way).
  assert.equal(fittingRoute('2117551513', '42'), '/fitting/2117551513/42')
})
