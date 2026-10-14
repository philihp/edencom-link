import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isCorpShare } from '../src/app/asset/corpShareSubject.ts'

const audiences = { corporations: [], alliances: [], hasLegacyToken: false, share: null }

describe('isCorpShare', () => {
  it('reads a corp payload by its corporation name', () => {
    assert.equal(isCorpShare({ ...audiences, corporationName: 'Hard Knocks Inc.' }), true)
  })

  it('reads a character payload as not a corp share, main or no main', () => {
    assert.equal(isCorpShare({ ...audiences, mainName: 'Sir Cuddles' }), false)
    assert.equal(isCorpShare({ ...audiences, mainName: null }), false)
    assert.equal(isCorpShare(audiences), false)
  })
})
