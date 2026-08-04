import { createYoga } from 'graphql-yoga'
import type { NextRequest } from 'next/server'

import { buildContext } from './context'
import { schema } from './schema'

// The dark-launched GraphQL endpoint (see /graphql for the in-browser editor).
// Auth is either the Supabase session cookie (same-origin, the editor page) or
// `Authorization: Bearer <api_token>` (external stockpile UIs — the same
// per-user token the Sheets CSV endpoints use); both are additionally gated on
// the account's `graphql` dark-launch flag (src/flags.ts). buildContext throws
// GraphQLErrors carrying extensions.http.status, which yoga maps to 401/403.
export const dynamic = 'force-dynamic'
// Headroom over Vercel's default function timeout for a large hangar, matching
// /api/character/assets.
export const maxDuration = 60

const { handleRequest } = createYoga({
  schema,
  context: ({ request }) => buildContext(request),
  graphqlEndpoint: '/api/graphql',
  fetchAPI: { Response },
  // The /graphql page is the in-browser UI; no bundled GraphiQL or landing page.
  graphiql: false,
  landingPage: false,
  batching: false,
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
// parameter is its own server context, not Next's { params }).
const handler = (request: NextRequest): Promise<Response> => Promise.resolve(handleRequest(request, {}))

export { handler as GET, handler as POST, handler as OPTIONS }
