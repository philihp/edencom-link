// MCP server endpoint (Streamable HTTP at /api/mcp). Clients authorize
// via OAuth 2.1 against Supabase Auth acting as the authorization server (the
// consent page lives at /oauth/consent; discovery metadata at
// /.well-known/oauth-protected-resource). Tools are read-only queries over
// the extracted DB — see tools.ts.
import { createMcpHandler, withMcpAuth } from 'mcp-handler'

import { verifySupabaseToken } from './auth'
import { registerTools } from './tools'

const handler = createMcpHandler(
  (server) => {
    registerTools(server)
  },
  { serverInfo: { name: 'edencom-link', version: '1.0.0' } },
  // No Redis in this deployment, so the (spec-deprecated) SSE transport stays
  // off; Streamable HTTP keeps everything within a single function invocation.
  // basePath derives the endpoint paths: '/api' makes the streamable HTTP
  // endpoint '/api/mcp' — exactly where this route file lives. (With
  // '/api/mcp' the handler would only answer '/api/mcp/mcp', a path no route
  // serves, so every authenticated call would 404.)
  { basePath: '/api', disableSse: true, maxDuration: 60 }
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
