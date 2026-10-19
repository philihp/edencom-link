import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const MCP_DIR = 'src/app/api/mcp'

// Every tool name the server registers, read from the source as text for the
// same reason the skill is: importing the modules would load their I/O.
const registeredTools = (): string[] =>
  readdirSync(join(process.cwd(), MCP_DIR))
    .filter((file) => file.endsWith('.ts'))
    .flatMap((file) =>
      Array.from(
        readFileSync(join(process.cwd(), MCP_DIR, file), 'utf-8').matchAll(/registerTool\(\s*'([a-z_]+)'/g),
        (match) => match[1]
      )
    )

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

  // get_skill is how an agent learns a tool exists, so a tool the document
  // never names is a tool agents do not reach for. Four went unnamed for weeks
  // before this check.
  it('names every tool the server registers', () => {
    const tools = registeredTools()
    assert.ok(tools.length > 20, `expected the MCP modules to register tools, found ${tools.length}`)
    const missing = tools.filter((tool) => !text.includes(`\`${tool}\``))
    assert.deepEqual(missing, [], `tools the skill document never names: ${missing.join(', ')}`)
  })
})
