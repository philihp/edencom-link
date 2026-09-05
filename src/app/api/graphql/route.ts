import { createYoga } from 'graphql-yoga'
import type { NextRequest } from 'next/server'

import { timed, withServerTiming } from '@/serverTiming'
import { createClient } from '@/utils/supabase/server'
import { buildContext } from './context'
import { schema } from './schema'
import { timingPlugin } from './timingPlugin'

// The GraphQL endpoint (see /graphql for the in-browser editor). Auth is
// either the Supabase session cookie (same-origin, the editor page) or
// `Authorization: Bearer <api_token>` (external stockpile UIs — the same
// per-user token the Sheets CSV endpoints use). buildContext throws
// GraphQLErrors carrying extensions.http.status, which yoga maps to 401/403.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large hangar, matching
// /api/character/assets.
export const maxDuration = 60

// GraphiQL is served on GET, and rendering it never touches a resolver — so
// without this the IDE shell would answer anonymous requests at a public path.
// Signing in is the whole test; everyone else gets yoga's 404. Queries are
// still authorized independently by buildContext.
const graphiqlForRequest = async (): Promise<boolean> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  return !error && data?.user != null
}

const { handleRequest } = createYoga({
  schema,
  // Timed apart from execution: context building is auth + flag lookups, the
  // execution phase is the resolvers' DB work (timingPlugin.ts spans it).
  context: ({ request }) => timed('graphql.context', () => buildContext(request)),
  graphqlEndpoint: '/api/graphql',
  fetchAPI: { Response },
  // GraphiQL for schema-aware autocomplete and the docs explorer; the /graphql
  // page's plain editor stays as the lightweight surface (and is what the Link
  // editor reuses). credentials same-origin so the IDE's own requests carry
  // the Supabase session cookie — the Bearer path is for external tools.
  graphiql: () =>
    graphiqlForRequest().then(
      (allowed) => allowed && { title: 'Edencom Link GraphQL', credentials: 'same-origin' as const }
    ),
  landingPage: false,
  batching: false,
  // One request.timing metric per executed operation (src/observability.js).
  plugins: [timingPlugin],
  // Wildcard origin with credentials OFF is the safe pairing: external UIs
  // authenticate with the Bearer token, and the session cookie only ever rides
  // same-origin requests (which need no CORS at all).
  cors: {
    origin: '*',
    credentials: false,
    methods: ['POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  },
})

// Thin wrapper only to satisfy Next's route-handler signature (yoga's second
// parameter is its own server context, not Next's { params }) — plus the
// Server-Timing scope, so the in-browser editor's network panel shows which
// resolvers a slow query spent its time in (src/serverTiming.ts).
const handler = withServerTiming((request: NextRequest): Promise<Response> =>
  Promise.resolve(handleRequest(request, {}))
)

export { handler as GET, handler as POST, handler as OPTIONS }
