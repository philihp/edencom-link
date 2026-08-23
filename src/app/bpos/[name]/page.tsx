import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { ShareDialog } from '../../asset/shareDialog'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { bposAccess, resolveBposAccount } from '../access'
import styles from '../bpos.module.css'
import { BposTable } from '../bposTable'
import { fetchBpoEntries } from '../data'
import { fetchBposShareDialogData } from '../shareData'
import { revokeBposShare, saveBposShare } from '../shareActions'
import { characterSlug } from '../slug'
import { totalBpos } from '../stack'

// A showcase page for one person's blueprint originals, addressed by their main
// character's name with spaces as dashes (/bpos/sir-cuddles). Private by
// default: the owner always sees their own, and anyone else needs a share the
// owner created — public, aimed at a corporation or alliance, or a signed link.
// Without one the URL is a 404, so a guessed name reveals nothing, not even
// that the account exists.
export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ name: string }>
  searchParams: Promise<{ share?: string }>
}

export const generateMetadata = async ({ params }: PageProps): Promise<Metadata> => {
  // Deliberately not resolved against the database: a title is rendered before
  // access is decided, so deriving it from the URL keeps the 404 case from
  // confirming whether the pilot exists.
  const { name } = await params
  return { title: `Blueprint originals — ${decodeURIComponent(name)}` }
}

const BposPage = async ({ params, searchParams }: PageProps) => {
  const { name } = await params
  const { share: shareParam } = await searchParams
  // Run the URL segment back through the slugger rather than just lowercasing
  // it, so /bpos/Sir%20Cuddles and /bpos/Sir-Cuddles both land on sir-cuddles.
  const slug = characterSlug(decodeURIComponent(name))

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewer = auth?.user ?? null

  const account = await resolveBposAccount(slug, viewer)
  if (!account) notFound()

  const access = await bposAccess(account, viewer, supabase, shareParam)
  if (!access) notFound()

  const entries = await fetchBpoEntries(account.registrations.map((r) => r.id))
  const total = totalBpos(entries)

  // The share dialog is the owner's own control, so it's fetched only for them.
  const shareData = access === 'owner' ? await fetchBposShareDialogData(supabase) : null

  return (
    <>
      {shareParam && <ShareUrlCleanup />}

      <div className={styles.pageHeader}>
        <h1>{`The Blueprint Library of ${account.mainName}`}</h1>
        {total > 0 && <span className={styles.count}>{total}</span>}
      </div>

      <p className={styles.subtitle}>
        <span>
          {entries.length === 1 ? '1 unique original' : `${entries.length} unique originals`}
          {total !== entries.length ? `, ${total} in total` : ''}
        </span>
        {shareData && (
          <ShareDialog
            subjectLabel="blueprint library"
            urlPath={`/bpos/${slug}`}
            data={shareData}
            save={saveBposShare.bind(null, slug)}
            revoke={revokeBposShare.bind(null, slug)}
            hint="Whoever you share with can see every blueprint original across all of your characters — name, ME, TE and how many you hold — live, until you stop sharing. Copies and everything else in your hangars stay private."
          />
        )}
      </p>

      {entries.length > 0 ? (
        <BposTable entries={entries} />
      ) : (
        <p className={styles.empty}>No blueprint originals in this collection.</p>
      )}
    </>
  )
}
export default BposPage
