import { notFound } from 'next/navigation'

import { ShareDialog } from '@/app/asset/shareDialog'
import { fetchShareAudiences, shareRowToState, type OwnRegistration } from '@/app/asset/shareData'
import { parseShareParam } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { siteUrl } from '@/utils/siteUrl'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { resolveLink } from '../access'
import { revokeLinkShare, saveLinkShare } from '../actions'
import { CopyLinkButton } from '../copyButton'
import { LinkTable } from '../linkTable'
import { LinkOwnerPanel } from '../ownerPanel'
import { runLink } from '../run'
import { shortLinkId } from '../shortId'
import styles from '../link.module.css'

// The =IMPORTDATA() formula for this Link's CSV, when one would work from
// Google Sheets: the signed share URL when the Link has one (Sheets carries no
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

// The Link viewer (docs/sharing-layer/07-link.md): runs the stored query
// under its CREATOR's security context and shows the result to anyone the
// link is shared with — RLS decides for signed-in audiences (corporation/
// alliance/public), a signed ?share= link for everyone else, including
// signed-out. The viewer receives results, never access.
//
// For the owner this is also where the Link is administered: CSV, Edit and
// Share all sit in the heading's corner, so issuing a Link is something you do
// while looking at the one you're issuing rather than from the index.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LinkViewerPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ share?: string }>
}) => {
  const { id } = await params
  const { share } = await searchParams

  const resolved = await resolveLink(id, share)
  if (!resolved) notFound()
  const { link, viewerIsOwner } = resolved

  const result = await runLink(link, { timing: { surface: 'link_view', route: '/link/[id]' } })
  // Hand the CSV link the short token, whichever generation arrived here.
  const cleanShare = share ? parseShareParam(share).signature : undefined
  const csvHref = `/link/${link.id}/csv${cleanShare ? `?share=${encodeURIComponent(cleanShare)}` : ''}`

  // "Save a copy" forks the query (not the data) into the viewer's own link
  // list — that's what a link shared with you being a "prewritten query" means.
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const canCopy = !viewerIsOwner && auth?.user != null

  // Only the owner gets the share dialog, and only the owner's read of
  // `registration` can name the corporations a Link may be aimed at.
  const owner = viewerIsOwner
    ? await (async () => {
        const [{ data: regs }, shortId] = await Promise.all([
          supabase.from('registration').select('id, corporation_id'),
          shortLinkId(link.id),
        ])
        const audiences = await fetchShareAudiences(supabase, (regs ?? []) as OwnRegistration[])
        const shareState = link.enabled ? shareRowToState(link) : null
        return { audiences, shortId, shareState, formula: importDataFormula(shareState, shortId) }
      })()
    : null

  return (
    <>
      {share && <ShareUrlCleanup />}
      <div className={styles.linkHeading}>
        <h1>{link.name}</h1>
        {owner ? (
          <LinkOwnerPanel
            link={{
              id: link.id,
              name: link.name,
              query: link.query,
              variables:
                link.variables && Object.keys(link.variables).length > 0 ? JSON.stringify(link.variables, null, 2) : '',
            }}
          >
            <a href={csvHref}>CSV</a>
            <ShareDialog
              subjectLabel="Link"
              urlPath={`/link/${owner.shortId}`}
              hint="Whoever this Link is issued to runs the query and reads its results — your data, current — until issuance is withdrawn. They receive the results only."
              data={{
                share: owner.shareState,
                corporations: owner.audiences.corporations,
                alliances: owner.audiences.alliances,
                hasLegacyToken: false,
              }}
              save={saveLinkShare.bind(null, link.id)}
              revoke={revokeLinkShare.bind(null, link.id)}
            />
          </LinkOwnerPanel>
        ) : (
          <div className={styles.buttons}>
            <a href={csvHref}>CSV</a>
            {canCopy && <CopyLinkButton linkId={link.id} share={cleanShare} />}
          </div>
        )}
      </div>

      {owner?.formula && (
        <p className={styles.note}>
          Google Sheets: <code>{owner.formula}</code>
        </p>
      )}

      {result.errors.length > 0 && (
        <p className={styles.error}>
          {result.errors.join(' — ')}
          <br />
          Advisory forwarded to Yulai.
        </p>
      )}

      <LinkTable data={result.data} />

      <details>
        <summary className={styles.note}>Raw result</summary>
        <pre className={styles.result}>{JSON.stringify({ data: result.data }, null, 2)}</pre>
      </details>
    </>
  )
}

export default LinkViewerPage
