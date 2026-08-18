import { Kind, type DocumentNode, type FieldNode, type OperationDefinitionNode } from 'graphql'
import type { Plugin } from 'graphql-yoga'

import { recordRequest } from '@/observability'
import { recordServerTimingSpan } from '@/serverTiming'

// The request.timing emitter for /api/graphql (src/observability.js): one
// metric line per executed operation, timed over the execution phase — the
// resolver/DB-bound span the BRIN measurement reads. Context building and
// auth failures never reach onExecute, so a rejected bearer emits nothing;
// that keeps the series to queries that actually touched data.

// Ad-hoc GraphQL callers may select several root fields (links are held to
// one). Joined sorted so "assets+characters" is one series however the query
// ordered them; the schema bounds the vocabulary, so cardinality stays flat.
const rootFieldsOf = (document: DocumentNode): string | null => {
  const operation = document.definitions.find((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  const names = (operation?.selectionSet.selections ?? [])
    .filter((s): s is FieldNode => s.kind === Kind.FIELD)
    .map((s) => s.name.value)
  return names.length > 0 ? [...new Set(names)].sort().join('+') : null
}

export const timingPlugin: Plugin = {
  onExecute: ({ args }) => {
    const startedAt = Date.now()
    const field = rootFieldsOf(args.document)
    return {
      onExecuteDone: ({ result }) => {
        // Incremental delivery (@defer/@stream) answers an AsyncIterable; not
        // enabled on this endpoint, so skip rather than misreport a partial.
        if (Symbol.asyncIterator in result) return
        // Also as a Server-Timing span, named by the root fields so a query
        // selecting several shows which combination cost what
        // (src/serverTiming.ts). Same clock, same phase, different audience.
        recordServerTimingSpan('graphql.execute', Date.now() - startedAt, field)
        recordRequest({
          route: '/api/graphql',
          surface: 'graphql',
          field,
          // The schema serves current data only — history stays on the legacy
          // at= CSV routes (docs/sharing-layer/09-sheets-parity.md).
          served: 'live',
          outcome: (result.errors ?? []).length > 0 ? 'query_failed' : 'ok',
          durationMs: Date.now() - startedAt,
        })
      },
    }
  },
}
