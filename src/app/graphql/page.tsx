import { redirect } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { establishedUser } from '../account/lib/establishedUser'
import { QueryEditor } from './queryEditor'
import styles from './graphql.module.css'

// The GraphQL explorer: query your own extracted data and build external
// stockpile interfaces against /api/graphql. Open to every signed-in account.
export const dynamic = 'force-dynamic'

const GraphqlPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }

  // The user's own api_token (RLS-scoped read), for the external-usage docs.
  const { data: settings } = await supabase
    .from('user_settings')
    .select('api_token')
    .eq('user_id', user.id)
    .maybeSingle()
  const apiToken = settings?.api_token ?? null

  return (
    <>
      <h1>GraphQL</h1>
      <p>
        Query your extracted data — assets, blueprints, orders, industry jobs, wallets — with GraphQL. This page posts
        to <code>/api/graphql</code> with your session; external tools authenticate with your API token instead. For
        autocomplete and a browsable schema, <a href="/api/graphql">open GraphiQL</a>.
      </p>

      <QueryEditor />

      <h2>Use it from your own tools</h2>
      <p>
        Send a POST to <code>/api/graphql</code> with your API token
        {apiToken === null && (
          <>
            {' '}
            (generate one under <a href="/account/settings">account settings</a>)
          </>
        )}
        :
      </p>
      <pre className={styles.docs}>
        {`curl -X POST https://edencom.link/api/graphql \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ${apiToken ?? '<your api token>'}' \\
  -d '{"query": "{ walletBalances { ownerName balance } }"}'`}
      </pre>
      <p className={styles.docsNote}>
        The endpoint answers cross-origin requests, so a static page on your own host can fetch it directly. Keep the
        token secret — it reads everything your account can see.
      </p>
    </>
  )
}

export default GraphqlPage
