import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LINK_FLAG, hasFlag } from '@/flags'
import { parseShareParam } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { resolveLink } from '../access'
import { CopyLinkButton } from '../copyButton'
import { LinkTable } from '../linkTable'
import { runLink } from '../run'
import styles from '../link.module.css'

// The Link viewer (docs/sharing-layer/07-link.md): runs the stored query
// under its CREATOR's security context and shows the result to anyone the
// link is shared with — RLS decides for signed-in audiences (corporation/
// alliance/public), a signed ?share= link for everyone else, including
// signed-out. The viewer receives results, never access.
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
  const { data: auth } = await (await createClient()).auth.getUser()
  const canCopy = !viewerIsOwner && auth?.user != null && (await hasFlag(auth.user.id, LINK_FLAG))

  return (
    <>
      {share && <ShareUrlCleanup />}
      <div className={styles.linkHeading}>
        <h1>{link.name}</h1>
        <div className={styles.buttons}>
          <a href={csvHref}>CSV</a>
          {viewerIsOwner && <Link href="/link">Edit</Link>}
          {canCopy && <CopyLinkButton linkId={link.id} share={cleanShare} />}
        </div>
      </div>

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
