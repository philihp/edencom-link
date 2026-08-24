import type { SupabaseClient } from '@supabase/supabase-js'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { match } from 'ts-pattern'

import { createClient } from '@/utils/supabase/server'

import { ShareDialog } from '../../asset/shareDialog'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { bposAccess, canManageShare, resolveBposSubject, type BposSubject } from '../access'
import styles from '../bpos.module.css'
import { BposTable } from '../bposTable'
import { fetchBpoEntries, fetchCorpBpoEntries } from '../data'
import { fetchBposShareDialogData, fetchCorpBposShareDialogData } from '../shareData'
import { revokeBposShare, revokeCorpBposShare, saveBposShare, saveCorpBposShare } from '../shareActions'
import { characterSlug } from '../slug'
import { totalBpos } from '../stack'

// A showcase page for one collection of blueprint originals, addressed by name
// with spaces as dashes (/bpos/sir-cuddles). The name is a CORPORATION's — the
// case that matters when originals live in a corp hangar and so belong to the
// corporation — or, failing that, a person's main character. Private by
// default: the subject's own people always see it, and anyone else needs a
// share they created — public, aimed at a corporation or alliance, or a signed
// link. Without one the URL is a 404, so a guessed name reveals nothing, not
// even that the collection exists.
export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ name: string }>
  searchParams: Promise<{ share?: string }>
}

export const generateMetadata = async ({ params }: PageProps): Promise<Metadata> => {
  // Deliberately not resolved against the database: a title is rendered before
  // access is decided, so deriving it from the URL keeps the 404 case from
  // confirming whether the subject exists.
  const { name } = await params
  return { title: `Blueprint originals — ${decodeURIComponent(name)}` }
}

// Everything that differs between the two subjects, decided once: what the page
// is called, where its blueprints come from, and the share plumbing behind the
// dialog. `.exhaustive()` is what makes a third subject a build error rather
// than a page that silently renders the wrong half.
const viewOf = (subject: BposSubject, slug: string, supabase: SupabaseClient) =>
  match(subject)
    .with({ kind: 'corporation' }, ({ corporationId, name }) => ({
      name,
      entries: () => fetchCorpBpoEntries(corporationId),
      shareData: () => fetchCorpBposShareDialogData(supabase, corporationId),
      save: saveCorpBposShare.bind(null, slug, corporationId),
      revoke: revokeCorpBposShare.bind(null, slug, corporationId),
      hint:
        'Whoever you share with can see every blueprint original in the corporation’s hangars — name, ME, TE and how many are held — live, until sharing stops. ' +
        'Copies and everything else in the hangars stay private. Any member of the corporation can change or revoke this.',
    }))
    .with({ kind: 'account' }, ({ registrations, mainName }) => ({
      name: mainName,
      entries: () => fetchBpoEntries(registrations.map((r) => r.id)),
      shareData: () => fetchBposShareDialogData(supabase),
      save: saveBposShare.bind(null, slug),
      revoke: revokeBposShare.bind(null, slug),
      hint:
        'Whoever you share with can see every blueprint original across all of your characters — name, ME, TE and how many you hold — live, until you stop sharing. ' +
        'Copies and everything else in your hangars stay private.',
    }))
    .exhaustive()

const BposPage = async ({ params, searchParams }: PageProps) => {
  const { name } = await params
  const { share: shareParam } = await searchParams
  // Run the URL segment back through the slugger rather than just lowercasing
  // it, so /bpos/Sir%20Cuddles and /bpos/Sir-Cuddles both land on sir-cuddles.
  const slug = characterSlug(decodeURIComponent(name))

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewer = auth?.user ?? null

  const subject = await resolveBposSubject(slug, viewer)
  if (!subject) notFound()

  const access = await bposAccess(subject, viewer, supabase, shareParam)
  if (!access) notFound()

  const view = viewOf(subject, slug, supabase)

  const entries = await view.entries()
  const total = totalBpos(entries)

  // The share dialog is the subject's own control, so it's fetched only for the
  // account's owner or a member of the corporation.
  const shareData = canManageShare(access) ? await view.shareData() : null

  return (
    <>
      {shareParam && <ShareUrlCleanup />}

      <div className={styles.pageHeader}>
        <h1>{`The Blueprint Library of ${view.name}`}</h1>
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
            save={view.save}
            revoke={view.revoke}
            hint={view.hint}
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
