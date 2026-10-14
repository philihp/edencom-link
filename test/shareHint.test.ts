import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shareHint, sharePath } from '../src/app/asset/shareHint.ts'

describe('sharePath', () => {
  it('drops the Assets root and the region › system prefix, ending at the subject', () => {
    const crumbs = [
      { href: null, label: 'Fountain', nav: true as const },
      { href: '/asset/30001', label: '27-HP0', nav: true as const },
      { href: '/asset/1035', label: '27-HP0 - Daniel C Sotiyo' },
      { href: '/asset/77', label: 'Cold Storage' },
    ]
    assert.deepEqual(sharePath(crumbs, 'Ammo (Station Warehouse Container)'), [
      '27-HP0 - Daniel C Sotiyo',
      'Cold Storage',
      'Ammo (Station Warehouse Container)',
    ])
  })

  it('is just the subject when nothing but navigation leads to it', () => {
    assert.deepEqual(sharePath([{ href: '/asset', label: 'Assets', nav: true }], 'Jita IV - Moon 4'), [
      'Jita IV - Moon 4',
    ])
  })
})

describe('shareHint', () => {
  it('names the location id, its path and you as the owner', () => {
    assert.equal(
      shareHint('1055810910787', ['27-HP0 - Daniel C Sotiyo', 'Ammo (Station Warehouse Container)'], { kind: 'you' }),
      "Share items in locationID '1055810910787' (27-HP0 - Daniel C Sotiyo › Ammo (Station Warehouse Container)) that are owned by you."
    )
  })

  it('names the corporation and what happens if you lose access to it', () => {
    assert.equal(
      shareHint('60003760', ['Jita IV - Moon 4'], { kind: 'corporation', name: 'Hard Knocks Inc.' }),
      "Share items in locationID '60003760' (Jita IV - Moon 4) that are owned by Hard Knocks Inc. and shared on behalf of you. If you lose access to your corp, the share will be disabled."
    )
  })
})
