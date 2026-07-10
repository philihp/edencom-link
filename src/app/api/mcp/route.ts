// MCP server endpoint (Streamable HTTP at /api/mcp/mcp). Clients authorize
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
  { basePath: '/api/mcp', disableSse: true, maxDuration: 60 }
)

const authHandler = withMcpAuth(handler, verifySupabaseToken, { required: true })

export { authHandler as GET, authHandler as POST, authHandler as DELETE }
export const maxDuration = 60
