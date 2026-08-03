import type { AuthInfo } from '@modelcontextprotocol/server'

import { createBearerClient } from '@/utils/supabase/bearer'

// Verify the bearer token an MCP client obtained from Supabase Auth's OAuth
// 2.1 server (enabled in the dashboard; consent page at /oauth/consent).
// getClaims verifies the JWT signature (via the project's JWKS for asymmetric
// keys, falling back to the Auth server for legacy symmetric ones) and
// expiry. The token is then reused as-is on PostgREST calls, so RLS scopes
// every tool to the user who authorized the client — a plain session JWT for
// the same user would grant exactly the same access.
export const verifySupabaseToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined
  const supabase = createBearerClient(bearerToken)
  const { data, error } = await supabase.auth.getClaims(bearerToken)
  const claims = data?.claims
  if (error || !claims?.sub) return undefined
  const clientId = (claims as Record<string, unknown>).client_id
  return {
    token: bearerToken,
    clientId: typeof clientId === 'string' ? clientId : 'unknown',
    scopes: typeof claims.scope === 'string' ? claims.scope.split(' ') : [],
    expiresAt: claims.exp,
    extra: { userId: claims.sub },
  }
}
