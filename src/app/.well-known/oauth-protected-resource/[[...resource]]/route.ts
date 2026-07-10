// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP server at
// /api/mcp. Points MCP clients at Supabase Auth as the authorization server
// (its RFC 8414 metadata lives at
// <supabase>/.well-known/oauth-authorization-server/auth/v1). The optional
// catch-all also serves the path-suffixed form some clients request
// (/.well-known/oauth-protected-resource/api/mcp/mcp).
import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from 'mcp-handler'

const handler = protectedResourceHandler({
  authServerUrls: [`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`],
})

export { handler as GET }
export const OPTIONS = metadataCorsOptionsRequestHandler()
