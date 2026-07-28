// Unit coverage for the /fitting/[characterId]/[fittingId] route builder
// (src/app/fitting/fit.ts). Trivial, but it's the one seam every fitting link
// on the site goes through (the list matrix, the MCP list_fittings tool), so
// pinning its exact shape catches a stray typo before it 404s a real link.
import assert from 'node:assert/strict'
import test from 'node:test'

import { fittingRoute } from '../src/app/fitting/fit.ts'

test('fittingRoute builds the two-segment path', () => {
  const characterId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  assert.equal(fittingRoute(characterId, 42), `/fitting/${characterId}/42`)
  // fitting_id can arrive as a string (PostgREST bigint) or a number.
  assert.equal(fittingRoute(characterId, '42'), `/fitting/${characterId}/42`)
})
