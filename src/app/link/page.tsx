import Link from 'next/link'
import { redirect } from 'next/navigation'

import { ShareDialog } from '@/app/asset/shareDialog'
import { fetchShareAudiences, shareRowToState, type OwnRegistration } from '@/app/asset/shareData'
import { LINK_FLAG, hasFlag } from '@/flags'
import { createClient } from '@/utils/supabase/server'

import { siteUrl } from '@/utils/siteUrl'

import { establishedUser } from '../account/lib/establishedUser'
import { revokeLinkShare, saveLinkShare } from './actions'
import { shortLinkId } from './shortId'
import { CopyLinkButton } from './copyButton'
import { LinkEditor } from './linkEditor'
import type { LinkRecord } from './run'
import styles from './link.module.css'

// The =IMPORTDATA() formula for a link's CSV, when one would work from Google
// Sheets: the signed share URL when the Link has one (Sheets carries no
// cookie), the bare CSV path when the Link is fully public, nothing else — a
// corp/alliance-only share has no URL an anonymous fetcher could use. Mirrors
// the legacy formulas /account/settings prints for the api_token routes.
const importDataFormula = (
  share: { shareParam: string | null; isPublic: boolean } | null,
  shortId: string
): string | null => {
  if (!share) return null
  if (share.shareParam) return `=IMPORTDATA("${siteUrl(`/link/${shortId}/csv`)}?share=${share.shareParam}")`
  if (share.isPublic) return `=IMPORTDATA("${siteUrl(`/link/${shortId}/csv`)}")`
  return null
}

// Dark-launched Link editor (docs/sharing-layer/07-link.md; no nav link):
// saved GraphQL queries that run under YOUR context when someone you shared
// them with opens them. Gated on the per-account `link` flag, the same
// gate-and-redirect shape as /graphql.
export const dynamic = 'force-dynamic'

const LinkPage = async () => {
  const supabase = await createClient()

  const user = await establishedUser(supabase)
  if (!user) {
    redirect('/account/login')
  }
  if (!(await hasFlag(user.id, LINK_FLAG))) {
    redirect('/')
  }

  // RLS shows the caller's own links AND ones shared with them (the audience
  // policy) — one read, split into the editor list and the shared-with-me list.
  const [{ data: linkRows }, { data: regs }] = await Promise.all([
    supabase.from('link').select('*').order('created_at'),
    supabase.from('registration').select('id, corporation_id'),
  ])
  const visible = (linkRows ?? []) as LinkRecord[]
  const links = visible.filter((l) => l.user_id === user.id)
  const sharedWithMe = visible.filter((l) => l.user_id !== user.id)
  const audiences = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])
  // The dialog's copyable URL carries the shortest id that resolves back to
  // each link, so what people paste onward is the graceful form.
  const shortIds = await Promise.all(links.map((link) => shortLinkId(link.id)))

  return (
    <>
      <h1>Data Links</h1>
      <p>
        A Link is a standing query registered against your materiel, works orders and fund position. It is issued to a
        corporation, to an alliance, to whoever holds a signed URL, or to everyone. Whoever opens it runs the query and
        receives <em>your</em> results — a reading, never access to the registry behind it. Every Link also renders as
        CSV, for operators who reconcile by spreadsheet.
      </p>

      <LinkEditor link={null} />

      {links.length === 0 && (
        <p className={styles.note}>
          No Links registered. Observation is not currently delegated to anyone. This has been logged.
        </p>
      )}

      {links.map((link, i) => {
        const share = link.enabled ? shareRowToState(link) : null
        const formula = importDataFormula(share, shortIds[i])
        return (
          <section key={link.id} className={styles.link}>
            <div className={styles.linkHeading}>
              <h2>
                <Link href={`/link/${link.id}`}>{link.name}</Link>
              </h2>
              <ShareDialog
                subjectLabel="Link"
                urlPath={`/link/${shortIds[i]}`}
                hint="Whoever this Link is issued to runs the query and reads its results — your data, current — until issuance is withdrawn. They receive the results only."
                data={{
                  share,
                  corporations: audiences.corporations,
                  alliances: audiences.alliances,
                  hasLegacyToken: false,
                }}
                save={saveLinkShare.bind(null, link.id)}
                revoke={revokeLinkShare.bind(null, link.id)}
              />
            </div>
            {formula && (
              <p className={styles.note}>
                Google Sheets: <code>{formula}</code>
              </p>
            )}
            <LinkEditor
              link={{
                id: link.id,
                name: link.name,
                query: link.query,
                variables:
                  link.variables && Object.keys(link.variables).length > 0
                    ? JSON.stringify(link.variables, null, 2)
                    : '',
              }}
            />
          </section>
        )
      })}

      {sharedWithMe.length > 0 && (
        <>
          <h2>Issued to you</h2>
          <p className={styles.note}>
            Links other operators have issued to you. Opening one reports <em>their</em> holdings. Retaining a copy
            keeps the query, registered as your own Link and run against your own.
          </p>
          {sharedWithMe.map((link) => (
            <section key={link.id} className={styles.link}>
              <div className={styles.linkHeading}>
                <h2>
                  <Link href={`/link/${link.id}`}>{link.name}</Link>
                </h2>
                <div className={styles.buttons}>
                  <CopyLinkButton linkId={link.id} />
                </div>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  )
}

export default LinkPage
