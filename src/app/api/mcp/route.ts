// MCP server endpoint (Streamable HTTP at /api/mcp). Clients authorize
// via OAuth 2.1 against Supabase Auth acting as the authorization server (the
// consent page lives at /oauth/consent; discovery metadata at
// /.well-known/oauth-protected-resource). Tools are read-only queries over
// the extracted DB — see tools.ts — with two exceptions: linkTools.ts can
// create and share a link, and watchedSystemTools.ts can edit the caller's
// /indexes watch list. Both write only rows the caller owns.
import { createMcpHandler, withMcpAuth } from 'mcp-handler'

import { verifySupabaseToken } from './auth'
import { registerEstateTools } from './estateTools'
import { registerExploreTools } from './exploreTools'
import { registerIndustryTools } from './industryTools'
import { registerLinkTools } from './linkTools'
import { registerShippingTools } from './shippingTools'
import { registerSkillTools } from './skillTools'
import { registerTools } from './tools'
import { registerWatchedSystemTools } from './watchedSystemTools'

// mcp-handler 2.x serves the 2026-07-28 spec (stateless, no sessions), falling
// back to stateless Streamable HTTP for 2025-era clients from the same handler.
// It no longer inspects the request path — routing belongs to the framework, so
// mounting this file at /api/mcp *is* the endpoint and the 1.x `basePath` dance
// is gone, along with `disableSse`/`redisUrl` (the SSE transport was removed)
// and the handler's own `maxDuration` (the route segment config below is what
// Vercel reads). Server options and handler extras are now one object.
const handler = createMcpHandler(
  (server) => {
    registerTools(server)
    registerEstateTools(server)
    registerIndustryTools(server)
    registerExploreTools(server)
    registerShippingTools(server)
    registerLinkTools(server)
    registerSkillTools(server)
    registerWatchedSystemTools(server)
  },
  {
    serverInfo: { name: 'edencom-link', version: '1.0.0' },
    // SEP-2549 cache hints. The SDK emits every cacheable 2026-07-28 result
    // with `ttlMs: 0` (immediately stale) and `cacheScope: 'private'` unless
    // told otherwise, so without this every client re-fetches the tool list on
    // every use. Both of these results are the same for every caller: tools are
    // registered unconditionally above, so nothing here varies by
    // who is asking, and `public` is honest even though the endpoint is
    // authenticated. RLS, not the cache scope, is what scopes the *data* a tool
    // returns. The TTL is how long a deploy that changes the tool list can take
    // to reach a client, since we send no `listChanged` notifications.
    cacheHints: {
      'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
      'server/discover': { ttlMs: 300_000, cacheScope: 'public' },
    },
  }
)

// Point the 401 WWW-Authenticate challenge at the path-suffixed protected-
// resource metadata (served by the [[...resource]] catch-all under
// .well-known), whose `resource` is the full server URL https://<host>/api/mcp.
// The default ('/.well-known/oauth-protected-resource') resolves to a document
// declaring just the origin, which fails the RFC 8707/9728 canonical-resource
// match that spec-compliant MCP clients (e.g. Claude) enforce — surfacing as
// "Authorization with the MCP server failed" only after discovery succeeds.
const authHandler = withMcpAuth(handler, verifySupabaseToken, {
  required: true,
  resourceMetadataPath: '/.well-known/oauth-protected-resource/api/mcp',
})

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
export const maxDuration = 60
