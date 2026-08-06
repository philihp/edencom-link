// Save-time validation for a Lens query (docs/sharing-layer/07-lens.md). A
// Lens runs its stored query under the CREATOR's context whenever a viewer
// opens it, so everything that can be rejected is rejected when the creator
// saves, not when a viewer runs:
//
// - it must parse and validate against the /api/graphql schema (built here
//   from the SDL with the plain `graphql` reference implementation — never
//   the executable schema, whose resolvers drag in Next/Supabase and would
//   sink the node test runner);
// - it must be a single query operation with exactly ONE top-level field, so
//   the CSV rendering's "primary list" is unambiguous;
// - it must not touch the session-only surfaces (`sharedWithMe`,
//   `includeShared:`): a Lens executes in token mode where those reject at
//   run time anyway, but failing at save time is a clear message instead of a
//   broken share.
//
// Pure module: `graphql` + the SDL only (relative .ts import so `node --test`
// can load it — see test/lensValidate.test.ts).
import { buildSchema, parse, validate, visit, Kind, type DocumentNode } from 'graphql'

import { typeDefs } from '../api/graphql/schema.graphql.ts'

// Root fields and argument names that only make sense on a cookie session.
// Extend in lockstep with requireSession call sites in resolvers.ts.
export const SESSION_ONLY_FIELDS = ['sharedWithMe']
export const SESSION_ONLY_ARGUMENTS = ['includeShared']

export type LensValidation = { ok: true } | { ok: false; message: string }

const invalid = (message: string): LensValidation => ({ ok: false, message })

const schema = buildSchema(typeDefs)

const sessionOnlyUse = (document: DocumentNode): string | null => {
  let found: string | null = null
  visit(document, {
    [Kind.FIELD]: (node) => {
      if (found === null && SESSION_ONLY_FIELDS.includes(node.name.value)) {
        found = `the "${node.name.value}" field`
      }
    },
    [Kind.ARGUMENT]: (node) => {
      if (found === null && SESSION_ONLY_ARGUMENTS.includes(node.name.value)) {
        found = `the "${node.name.value}" argument`
      }
    },
  })
  return found
}

export const validateLensQuery = (query: string): LensValidation => {
  let document: DocumentNode
  try {
    document = parse(query)
  } catch (e) {
    return invalid(`The query does not parse: ${e instanceof Error ? e.message : String(e)}`)
  }

  const operations = document.definitions.filter((d) => d.kind === Kind.OPERATION_DEFINITION)
  if (operations.length !== 1) {
    return invalid('A lens holds exactly one operation.')
  }
  const [operation] = operations
  if (operation.operation !== 'query') {
    return invalid('A lens must be a query operation.')
  }

  const errors = validate(schema, document)
  if (errors.length > 0) {
    return invalid(`The query is not valid against the schema: ${errors[0].message}`)
  }

  const topLevel = operation.selectionSet.selections.filter((s) => s.kind === Kind.FIELD)
  if (operation.selectionSet.selections.length !== topLevel.length || topLevel.length !== 1) {
    return invalid('A lens selects exactly one top-level field, so its CSV rendering is unambiguous.')
  }

  const sessionOnly = sessionOnlyUse(document)
  if (sessionOnly !== null) {
    return invalid(
      `A lens cannot use ${sessionOnly} — that surface is session-only. A lens already runs in its creator's context.`
    )
  }

  return { ok: true }
}

// The stored variables must be a JSON object (fixed by the creator at save
// time; viewers never supply variables).
export const parseLensVariables = (
  raw: string
): { ok: true; variables: Record<string, unknown> } | { ok: false; message: string } => {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, variables: {} }
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'Variables must be a JSON object, e.g. { "item": "Tritanium" }' }
    }
    return { ok: true, variables: parsed as Record<string, unknown> }
  } catch {
    return { ok: false, message: 'Variables must be a JSON object, e.g. { "item": "Tritanium" }' }
  }
}
