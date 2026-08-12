import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../../account/lib/establishedUser'

import { approveAuthorization, denyAuthorization } from './actions'

// OAuth 2.1 consent page. Supabase Auth (acting as the authorization server
// for the MCP endpoint at /api/mcp) redirects here with an authorization_id
// when a client like Claude asks for access; this page shows who's asking and
// lets the signed-in user approve or deny. The Authorization Path in the
// Supabase dashboard (Authentication → OAuth Server) must point at
// /oauth/consent for this to be reached.
const ConsentPage = async ({ searchParams }: { searchParams: Promise<{ authorization_id?: string }> }) => {
  const { authorization_id: authorizationId } = await searchParams
  if (!authorizationId) {
    redirect('/')
  }

  const supabase = await createClient()
  const user = await establishedUser(supabase)
  if (!user) {
    redirect(`/account/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${authorizationId}`)}`)
  }

  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId)
  if (error || !data) {
    return (
      <>
        <h1>Authorize Application</h1>
        <p>This authorization request is invalid or has expired. Start the connection again from the application.</p>
      </>
    )
  }

  // Already-consented requests skip the consent screen entirely.
  if (!('authorization_id' in data)) {
    redirect(data.redirect_url)
  }

  return (
    <>
      <h1>Authorize Application</h1>
      <p>
        <strong>{data.client.name ?? 'An application'}</strong> is asking for access to your EDENCOM Link account (
        {data.user.email}).
      </p>
      {data.scope && (
        <>
          <p>It requests the following scopes:</p>
          <ul>
            {data.scope.split(' ').map((scope) => (
              <li key={scope}>{scope}</li>
            ))}
          </ul>
        </>
      )}
      <p>
        It will be able to read the EVE data linked to your account — assets, blueprints, clones, industry jobs, market
        orders, and transactions.
      </p>
      <form>
        <input type="hidden" name="authorization_id" value={data.authorization_id} />
        <button formAction={approveAuthorization}>Approve</button> <button formAction={denyAuthorization}>Deny</button>
      </form>
    </>
  )
}

export default ConsentPage
