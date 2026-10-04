// Unit coverage for the Vercel ignored-build decision
// (scripts/vercelIgnoreBuild.mjs). The costly mistake is a false skip: a push
// that changes code but reads as docs-only never gets a preview, and nobody
// notices until the production deploy. So every case here that could be read
// either way is pinned toward building.
import assert from 'node:assert/strict'
import test from 'node:test'

import { SERVED_DOCS, decide, isDocsOnly } from '../scripts/vercelIgnoreBuild.mjs'

test('a push that changes only docs/ is skipped', () => {
  const { skip, reason } = decide(['docs/ios-app/README.md', 'docs/ios-app/00-spike.md'])
  assert.equal(skip, true)
  assert.match(reason, /only docs\/ changed/)
})

test('one code file among docs changes means build, and the reason names it', () => {
  const { skip, reason } = decide(['docs/ios-app/README.md', 'src/app/isk.ts'])
  assert.equal(skip, false)
  assert.match(reason, /src\/app\/isk\.ts changed/)
})

test('the skill file is served by the deployment, so it is never docs-only', () => {
  assert.deepEqual(SERVED_DOCS, ['docs/edencom-industry-SKILL.md'])
  assert.equal(isDocsOnly('docs/edencom-industry-SKILL.md'), false)
  const { skip, reason } = decide(['docs/edencom-industry-SKILL.md'])
  assert.equal(skip, false)
  assert.match(reason, /edencom-industry-SKILL\.md changed/)
})

test('an empty diff builds (a redeploy is not a docs change)', () => {
  assert.equal(decide([]).skip, false)
})

test('only a path under docs/ counts; a file merely named docs does not', () => {
  assert.equal(isDocsOnly('docs/a.md'), true)
  assert.equal(isDocsOnly('docs/deep/er/path.sql'), true)
  assert.equal(isDocsOnly('src/docs/a.md'), false)
  assert.equal(isDocsOnly('docsite/a.md'), false)
  assert.equal(isDocsOnly('CLAUDE.md'), false)
})
