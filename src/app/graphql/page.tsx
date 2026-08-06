import { redirect } from 'next/navigation'

import { GRAPHQL_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'
import { QueryEditor } from './queryEditor'
import styles from './graphql.module.css'

// Dark-launched GraphQL explorer (no nav link): query your own extracted data
// and build external stockpile interfaces against /api/graphql. Gated on the
// per-account `graphql` flag in user_settings.flags.
export const dynamic = 'force-dynamic'

const GraphqlPage = async () => {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/account/login')
  }
  if (!(await hasFlag(data.user.id, GRAPHQL_FLAG))) {
    redirect('/')
  }

  // The user's own api_token (RLS-scoped read), for the external-usage docs.
  const { data: settings } = await supabase
    .from('user_settings')
    .select('api_token')
    .eq('user_id', data.user.id)
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
