import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LENS_FLAG, hasFlag } from '@/flags'
import { parseShareParam } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { resolveLens } from '../access'
import { CopyLensButton } from '../copyButton'
import { LensTable } from '../lensTable'
import { runLens } from '../run'
import styles from '../lens.module.css'

// The Lens viewer (docs/sharing-layer/07-lens.md): runs the stored query
// under its CREATOR's security context and shows the result to anyone the
// lens is shared with — RLS decides for signed-in audiences (corporation/
// alliance/public), a signed ?share= link for everyone else, including
// signed-out. The viewer receives results, never access.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const LensViewerPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ share?: string }>
}) => {
  const { id } = await params
  const { share } = await searchParams

  const resolved = await resolveLens(id, share)
  if (!resolved) notFound()
  const { lens, viewerIsOwner } = resolved

  const result = await runLens(lens, { timing: { surface: 'lens_view', route: '/lens/[id]' } })
  // Hand the CSV link the short token, whichever generation arrived here.
  const cleanShare = share ? parseShareParam(share).signature : undefined
  const csvHref = `/lens/${lens.id}/csv${cleanShare ? `?share=${encodeURIComponent(cleanShare)}` : ''}`

  // "Save a copy" forks the query (not the data) into the viewer's own lens
  // list — that's what a lens shared with you being a "prewritten query" means.
  const { data: auth } = await (await createClient()).auth.getUser()
  const canCopy = !viewerIsOwner && auth?.user != null && (await hasFlag(auth.user.id, LENS_FLAG))

  return (
    <>
      {share && <ShareUrlCleanup />}
      <div className={styles.lensHeading}>
        <h1>{lens.name}</h1>
        <div className={styles.buttons}>
          <a href={csvHref}>CSV</a>
          {viewerIsOwner && <Link href="/lens">Edit</Link>}
          {canCopy && <CopyLensButton lensId={lens.id} share={cleanShare} />}
        </div>
      </div>

      {result.errors.length > 0 && <p className={styles.error}>{result.errors.join(' — ')}</p>}

      <LensTable data={result.data} />

      <details>
        <summary className={styles.note}>Raw result</summary>
        <pre className={styles.result}>{JSON.stringify({ data: result.data }, null, 2)}</pre>
      </details>
    </>
  )
}

export default LensViewerPage
