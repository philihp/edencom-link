import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Read the file directly rather than importing skillTools — its ./lib import
// drags in I/O modules the pure test runner has no business loading.
const SKILL_PATH = 'docs/edencom-industry-SKILL.md'

describe('edencom-industry-SKILL.md', () => {
  const text = readFileSync(join(process.cwd(), SKILL_PATH), 'utf-8')

  it('exists and is substantial', () => {
    assert.ok(text.length > 2_000, `expected more than 2,000 characters, got ${text.length}`)
  })

  it('mentions the GraphQL tools it teaches', () => {
    assert.ok(text.includes('run_query'))
    assert.ok(text.includes('link_schema'))
    assert.ok(text.includes('create_link'))
  })
})
