// Unit coverage for the /fitting/[fittingId] route-param encoding
// (src/app/fitting/fit.ts). Personal and shared fittings share one URL shape
// over two different id spaces, so what matters here is that the two never
// collide: a uuid (shared) round-trips as itself, a composite
// characterId_fittingId (personal) round-trips as its parts, and a malformed
// composite is rejected rather than silently misparsed.
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFittingRouteParam, personalFittingRoute, sharedFittingRoute } from '../src/app/fitting/fit.ts'

test('a shared fitting uuid round-trips through the route helpers', () => {
  const sharedId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  assert.equal(sharedFittingRoute(sharedId), `/fitting/${sharedId}`)
  assert.deepEqual(parseFittingRouteParam(sharedId), { kind: 'shared', sharedId })
})

test('a personal fitting (registration uuid + numeric fitting_id) round-trips', () => {
  const characterId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  const href = personalFittingRoute(characterId, 42)
  assert.equal(href, `/fitting/${characterId}_42`)
  assert.deepEqual(parseFittingRouteParam(href.slice('/fitting/'.length)), {
    kind: 'personal',
    characterId,
    fittingId: '42',
  })
})

test('parseFittingRouteParam rejects a composite with a non-numeric fitting id', () => {
  const characterId = '3fa85f64-5717-4562-b3fc-2c963f66afa6'
  assert.equal(parseFittingRouteParam(`${characterId}_not-a-number`), null)
})
