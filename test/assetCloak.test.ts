import assert from 'node:assert/strict'
import test from 'node:test'

import { CLOAKED_LOCATION, cloakCrumbs, NO_FLAGS, shareFlagsOf } from '../src/app/asset/cloak.ts'

test('shareFlagsOf: no rows set no flags', () => {
  assert.deepEqual(shareFlagsOf([]), NO_FLAGS)
})

test('shareFlagsOf: any covering share that asks for a flag sets it', () => {
  assert.deepEqual(shareFlagsOf([{ show_as_main: true, cloak_location: false }, { cloak_location: true }]), {
    showAsMain: true,
    cloakLocation: true,
  })
  assert.deepEqual(shareFlagsOf([{ show_as_main: null, cloak_location: true }]), {
    showAsMain: false,
    cloakLocation: true,
  })
})

test('cloakCrumbs keeps only the Assets root: no region, system, place, ship or container', () => {
  const crumbs = [
    { href: null, label: 'Insmother', nav: true as const },
    { href: '/asset/30004601', label: 'C-J6MT', nav: true as const },
    { href: '/asset/1035466617946', label: 'C-J6MT - Keepstar' },
    { href: '/asset/1040000000001', label: 'Nyx' },
  ]
  assert.deepEqual(cloakCrumbs(crumbs), [])
  assert.deepEqual(cloakCrumbs([{ href: '/asset', label: 'Assets', nav: true }, ...crumbs]), [
    { href: '/asset', label: 'Assets', nav: true },
  ])
})

test('the cloaked line reads as the owner asked', () => {
  assert.equal(CLOAKED_LOCATION, 'Location cloaked')
})
