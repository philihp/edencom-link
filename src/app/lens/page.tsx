import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ShareDialog } from '@/app/asset/shareDialog'
import { fetchShareAudiences, shareRowToState, type OwnRegistration } from '@/app/asset/shareData'
import { LENS_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { siteUrl } from '@/utils/siteUrl'

import { establishedUser } from '../account/lib/establishedUser'
import { revokeLensShare, saveLensShare } from './actions'
import { shortLensId } from './shortId'
import { CopyLensButton } from './copyButton'
import { LensEditor } from './lensEditor'
import type { LensRecord } from './run'
import styles from './lens.module.css'

// The =IMPORTDATA() formula for a lens's CSV, when one would work from Google
// Sheets: a signed link when the lens has one (Sheets carries no cookie), the
// bare CSV path when the lens is fully public, nothing otherwise — a
// corp/alliance-only share has no URL an anonymous fetcher could use. Mirrors
// the legacy formulas /account/settings prints for the api_token routes.
const importDataFormula = (
  share: { shareParam: string | null; isPublic: boolean } | null,
  shortId: string
): string | null => {
  if (!share) return null
  if (share.shareParam) return `=IMPORTDATA("${siteUrl(`/lens/${shortId}/csv`)}?share=${share.shareParam}")`
  if (share.isPublic) return `=IMPORTDATA("${siteUrl(`/lens/${shortId}/csv`)}")`
  return null
}

// Dark-launched Lens editor (docs/sharing-layer/07-lens.md; no nav link):
// saved GraphQL queries that run under YOUR context when someone you shared
// them with opens them. Gated on the per-account `lens` flag, the same
// gate-and-redirect shape as /graphql.
export const dynamic = 'force-dynamic'

const LensPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }
  if (!(await hasFlag(user.id, LENS_FLAG))) {
    redirect('/')
  }

  // RLS shows the caller's own lenses AND ones shared with them (the audience
  // policy) — one read, split into the editor list and the shared-with-me list.
  const [{ data: lensRows }, { data: regs }] = await Promise.all([
    supabase.from('lens').select('*').order('created_at'),
    supabase.from('registration').select('id, corporation_id'),
  ])
  const visible = (lensRows ?? []) as LensRecord[]
  const lenses = visible.filter((l) => l.user_id === user.id)
  const sharedWithMe = visible.filter((l) => l.user_id !== user.id)
  const audiences = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])
  // The dialog's copyable URL carries the shortest id that resolves back to
  // each lens, so what people paste onward is the graceful form.
  const shortIds = await Promise.all(lenses.map((lens) => shortLensId(lens.id)))

  return (
    <>
      <h1>Lenses</h1>
      <p>
        A lens is a saved GraphQL query over your data that you can share like any other share — with corporations,
        alliances, a link, or publicly. Whoever opens it sees <em>your</em> results (they never gain access beyond the
        query), and every lens also renders as CSV for spreadsheets.
      </p>

      <LensEditor lens={null} />

      {lenses.map((lens, i) => {
        const share = lens.enabled ? shareRowToState(lens) : null
        const formula = importDataFormula(share, shortIds[i])
        return (
          <section key={lens.id} className={styles.lens}>
            <div className={styles.lensHeading}>
              <h2>
                <Link href={`/lens/${lens.id}`}>{lens.name}</Link>
              </h2>
              <ShareDialog
                subjectLabel="lens"
                urlPath={`/lens/${shortIds[i]}`}
                hint="Whoever you share with can run this query and see its results — your data, live — until you stop sharing."
                data={{
                  share,
                  corporations: audiences.corporations,
                  alliances: audiences.alliances,
                  hasLegacyToken: false,
                }}
                save={saveLensShare.bind(null, lens.id)}
                revoke={revokeLensShare.bind(null, lens.id)}
              />
            </div>
            {formula && (
              <p className={styles.note}>
                Google Sheets: <code>{formula}</code>
              </p>
            )}
            <LensEditor
              lens={{
                id: lens.id,
                name: lens.name,
                query: lens.query,
                variables:
                  lens.variables && Object.keys(lens.variables).length > 0
                    ? JSON.stringify(lens.variables, null, 2)
                    : '',
              }}
            />
          </section>
        )
      })}

      {sharedWithMe.length > 0 && (
        <>
          <h2>Shared with me</h2>
          <p className={styles.note}>
            Lenses others aimed at you. Opening one shows <em>their</em> results; saving a copy keeps the query as your
            own lens, over your data.
          </p>
          {sharedWithMe.map((lens) => (
            <section key={lens.id} className={styles.lens}>
              <div className={styles.lensHeading}>
                <h2>
                  <Link href={`/lens/${lens.id}`}>{lens.name}</Link>
                </h2>
                <div className={styles.buttons}>
                  <CopyLensButton lensId={lens.id} />
                </div>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  )
}

export default LensPage
