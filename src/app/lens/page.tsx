import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ShareDialog } from '@/app/asset/shareDialog'
import { fetchShareAudiences, shareRowToState, type OwnRegistration } from '@/app/asset/shareData'
import { LENS_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'
import { revokeLensShare, saveLensShare } from './actions'
import { LensEditor } from './lensEditor'
import type { LensRecord } from './run'
import styles from './lens.module.css'

// Dark-launched Lens editor (docs/sharing-layer/07-lens.md; no nav link):
// saved GraphQL queries that run under YOUR context when someone you shared
// them with opens them. Gated on the per-account `lens` flag, the same
// gate-and-redirect shape as /graphql.
export const dynamic = 'force-dynamic'

const LensPage = async () => {
  const supabase = await createClient()

  const { data: auth, error } = await supabase.auth.getUser()
  if (error || !auth?.user) {
    redirect('/account/login')
  }
  if (!(await hasFlag(auth.user.id, LENS_FLAG))) {
    redirect('/')
  }

  // RLS also shows lenses others shared with the caller; the editor lists
  // only their own.
  const [{ data: lensRows }, { data: regs }] = await Promise.all([
    supabase.from('lens').select('*').eq('user_id', auth.user.id).order('created_at'),
    supabase.from('registration').select('id, corporation_id'),
  ])
  const lenses = (lensRows ?? []) as LensRecord[]
  const audiences = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])

  return (
    <>
      <h1>Lenses</h1>
      <p>
        A lens is a saved GraphQL query over your data that you can share like any other share — with corporations,
        alliances, a link, or publicly. Whoever opens it sees <em>your</em> results (they never gain access beyond the
        query), and every lens also renders as CSV for spreadsheets.
      </p>

      <LensEditor lens={null} />

      {lenses.map((lens) => (
        <section key={lens.id} className={styles.lens}>
          <div className={styles.lensHeading}>
            <h2>
              <Link href={`/lens/${lens.id}`}>{lens.name}</Link>
            </h2>
            <ShareDialog
              subjectLabel="lens"
              urlPath={`/lens/${lens.id}`}
              hint="Whoever you share with can run this query and see its results — your data, live — until you stop sharing."
              data={{
                share: lens.enabled ? shareRowToState(lens) : null,
                corporations: audiences.corporations,
                alliances: audiences.alliances,
                hasLegacyToken: false,
              }}
              save={saveLensShare.bind(null, lens.id)}
              revoke={revokeLensShare.bind(null, lens.id)}
            />
          </div>
          <LensEditor
            lens={{
              id: lens.id,
              name: lens.name,
              query: lens.query,
              variables:
                lens.variables && Object.keys(lens.variables).length > 0 ? JSON.stringify(lens.variables, null, 2) : '',
            }}
          />
        </section>
      ))}
    </>
  )
}

export default LensPage
