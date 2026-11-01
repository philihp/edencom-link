// The register a ship's memory is written in (src/app/ship/memory/register.ts,
// docs/ship-memory.md "Register by hull class"). The chart is the owner's to
// edit in the doc, so every register the module knows is pinned against the
// doc's rows, as the accent test does for its chart.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { GENERIC_REGISTER, REGISTER_BY_GROUP, registerOf } from '../src/app/ship/memory/register.ts'

const DOC_PATH = 'docs/ship-memory.md'

const docChart = (): Array<{ label: string; register: string }> => {
  const lines = readFileSync(join(process.cwd(), DOC_PATH), 'utf-8').split('\n')
  const header = lines.findIndex((line) => line.startsWith('| Hull class'))
  assert.ok(header >= 0, `no register chart in ${DOC_PATH}`)
  const rows = lines.slice(header + 2)
  const end = rows.findIndex((line) => !line.startsWith('|'))
  return rows.slice(0, end === -1 ? undefined : end).map((line) => {
    const [label, register] = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    return { label, register }
  })
}

test('every register in the module is a row of the doc’s chart, word for word, and every row is used', () => {
  const doc = docChart()
  const used = [...new Set(Object.values(REGISTER_BY_GROUP))].sort((a, b) => a.label.localeCompare(b.label))
  assert.deepEqual(
    used.map((r) => ({ label: r.label, register: r.register })),
    [...doc].sort((a, b) => a.label.localeCompare(b.label))
  )
})

test('groups place where a player would put them', () => {
  assert.equal(registerOf('Frigate').register, 'Young and eager; brags')
  assert.equal(registerOf('Tactical Destroyer').register, 'Young and eager; brags')
  assert.equal(registerOf('Strategic Cruiser').register, 'Seasoned; has opinions')
  assert.equal(registerOf('Marauder').register, 'Grand, slow, sure of itself')
  assert.equal(registerOf('Hauler').register, 'A weary teamster who knows every dock')
  assert.equal(registerOf('Industrial').register, registerOf('Hauler').register)
  assert.equal(registerOf('Jump Freighter').register, 'A weary teamster who knows every dock')
  assert.equal(registerOf('Capital Industrial Ship').register, 'Patient; talks about the rock')
  assert.equal(registerOf('Titan').register, 'Ancient and ponderous; remembers everything')
  assert.equal(registerOf('Capsule').register, 'Small and earnest')
})

test('an unplaced group, or none, reads as the generic register rather than nothing', () => {
  assert.deepEqual(registerOf('Citizen Ships'), GENERIC_REGISTER)
  assert.deepEqual(registerOf(null), GENERIC_REGISTER)
  assert.deepEqual(registerOf(undefined), GENERIC_REGISTER)
})
