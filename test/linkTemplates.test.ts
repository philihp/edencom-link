// The shared template list (src/app/link/templates.ts) is the load-bearing
// drift guard between three surfaces — the /link picker, the /graphql example
// buttons, and the MCP link_schema examples — and the legacy CSV routes it
// supersedes: a schema change that breaks a template, or a column drifting
// from its legacy counterpart, fails here before a user pastes a dead formula.
import assert from 'node:assert/strict'
import test from 'node:test'

import { Kind, parse, type FieldNode, type OperationDefinitionNode } from 'graphql'

import {
  CHARACTER_ASSET_COLUMNS,
  CHARACTER_BLUEPRINT_COLUMNS,
  CHARACTER_JOB_COLUMNS,
  CHARACTER_ORDER_COLUMNS,
  CORP_ASSET_COLUMNS,
  CORP_BLUEPRINT_COLUMNS,
  CORP_JOB_COLUMNS,
} from '../src/app/api/csvColumns.ts'
import { LINK_TEMPLATES } from '../src/app/link/templates.ts'
import { validateLinkQuery } from '../src/app/link/validate.ts'

// The CSV header a template produces: response keys follow the selection
// aliases in order, so this is the root field's selections — or its `rows`
// sub-selection when the root returns a page object (assets, blueprints).
const csvColumnsOf = (query: string): string[] => {
  const document = parse(query)
  const operation = document.definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  const root = operation?.selectionSet.selections.find((s): s is FieldNode => s.kind === Kind.FIELD)
  const rows = root?.selectionSet?.selections.find(
    (s): s is FieldNode => s.kind === Kind.FIELD && s.name.value === 'rows'
  )
  const source = rows?.selectionSet ?? root?.selectionSet
  return (source?.selections ?? [])
    .filter((s): s is FieldNode => s.kind === Kind.FIELD)
    .map((s) => s.alias?.value ?? s.name.value)
}

const templateById = (id: string) => {
  const found = LINK_TEMPLATES.find((t) => t.id === id)
  assert.ok(found, `template ${id} exists`)
  return found
}

test('template ids are unique', () => {
  assert.equal(new Set(LINK_TEMPLATES.map((t) => t.id)).size, LINK_TEMPLATES.length)
})

test('every template passes link validation against the live schema', () => {
  for (const t of LINK_TEMPLATES) {
    assert.deepEqual(validateLinkQuery(t.query), { ok: true }, t.id)
  }
})

test('every labelled field names a variable its query declares', () => {
  for (const t of LINK_TEMPLATES) {
    const declared = new Set(
      (
        parse(t.query).definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
          ?.variableDefinitions ?? []
      ).map((v) => v.variable.name.value)
    )
    for (const field of t.variableFields ?? []) {
      assert.ok(declared.has(field.name), `${t.id}: $${field.name}`)
    }
  }
})

// The Sheets drop-ins: alias-for-alias equal to the legacy routes' default
// column lists, so the link CSV's header row is byte-identical and an existing
// =IMPORTDATA() tab re-points cleanly (docs/sharing-layer/09-sheets-parity.md).
test('the drop-in templates match the legacy CSV columns exactly', () => {
  const parity: Array<[string, readonly string[]]> = [
    ['sheets-character-assets', CHARACTER_ASSET_COLUMNS],
    ['sheets-character-blueprints', CHARACTER_BLUEPRINT_COLUMNS],
    ['sheets-character-orders', CHARACTER_ORDER_COLUMNS],
    ['sheets-character-jobs', CHARACTER_JOB_COLUMNS],
    ['sheets-corp-assets', CORP_ASSET_COLUMNS],
    ['sheets-corp-blueprints', CORP_BLUEPRINT_COLUMNS],
    ['sheets-corp-jobs', CORP_JOB_COLUMNS],
  ]
  for (const [id, columns] of parity) {
    assert.deepEqual(csvColumnsOf(templateById(id).query), [...columns], id)
  }
})
