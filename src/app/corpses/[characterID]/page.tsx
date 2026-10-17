import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { createClient } from '@/utils/supabase/server'

import { ShareDialog } from '../../asset/shareDialog'
import { shareCardMetadata, shareQuery } from '../../shareCardMetadata'
import { ShareUrlCleanup } from '../../shareUrlCleanup'
import { CARD_HEIGHT, CARD_WIDTH } from '../../ship/[itemId]/card/cardModel'
import { TypeIcon } from '../../typeIcon'
import { canManageCorpseShare, corpseAccess, resolveCorpseSubject } from '../access'
import { loadCorpseCollection } from '../collection'
import styles from '../corpses.module.css'
import { revokeCorpsesShare, saveCorpsesShare } from '../shareActions'
import { fetchCorpsesShareDialogData } from '../shareData'
import { loadCorpsesCard } from './card/loadCard'

// One account's frozen-corpse collection, addressed by the account's MAIN
// character id. Private by default: the owner always sees their own page —
// that's where the share dialog lives — and anyone else needs a share the
// owner created (public, aimed at a corporation or alliance, or a signed
// link). Without one the URL is a 404, so a guessed character id reveals
// nothing, not even that the account exists here.
//
// Addressing by the main alone is load-bearing. The collection pools every
// character's corpses and the page is titled with the main, so letting an
// ALT's id resolve would hand an anonymous visitor the main's name, and two
// ids rendering one page would prove a shared owner (../access.ts).
export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ characterID: string }>
  searchParams: Promise<{ share?: string }>
}

// The title says nothing the URL didn't, so the 404 case never confirms
// whether the account exists. Only a collection a signed-out visitor could
// open — fully public, or opened by this signed ?share= link — gets the link
// preview a chat client unfurls (./card/loadCard.ts); that visitor sees the
// page anyway.
export const generateMetadata = async ({ params, searchParams }: PageProps): Promise<Metadata> => {
  const { characterID } = await params
  const { share } = await searchParams
  const card = await loadCorpsesCard(characterID, share)
  if (!card) return { title: 'Frozen corpses' }
  return shareCardMetadata({
    title: card.title,
    typeName: card.title,
    description: card.description,
    imagePath: `/corpses/${characterID}/card${share ? `?${shareQuery({ share })}` : ''}`,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })
}

export const generateViewport = async ({ params, searchParams }: PageProps): Promise<Viewport> => {
  const { characterID } = await params
  const { share } = await searchParams
  const card = await loadCorpsesCard(characterID, share)
  return card ? { themeColor: card.color } : {}
}

const CorpsesPage = async ({ params, searchParams }: PageProps) => {
  const { characterID } = await params
  const { share: shareParam } = await searchParams

  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  const viewer = auth?.user ?? null

  const subject = await resolveCorpseSubject(characterID)
  if (!subject) notFound()

  const access = await corpseAccess(subject, viewer, supabase, shareParam)
  if (!access) notFound()

  const collection = await loadCorpseCollection(characterID)
  if (!collection) notFound()
  const { accountName, corpses } = collection

  // The share dialog is the owner's own control.
  const shareData = canManageCorpseShare(access) ? await fetchCorpsesShareDialogData(supabase) : null

  return (
    <>
      {shareParam && <ShareUrlCleanup />}

      <div className={styles.pageHeader}>
        <h1>{`The Many Corpses of ${accountName}`}</h1>
        {corpses.length > 0 && <span className={styles.count}>{corpses.length}</span>}
      </div>

      {shareData && (
        <p className={styles.subtitle}>
          <ShareDialog
            subjectLabel="corpse collection"
            urlPath={`/corpses/${characterID}`}
            data={shareData}
            save={saveCorpsesShare.bind(null, characterID)}
            revoke={revokeCorpsesShare.bind(null, characterID)}
            hint={
              'Whoever you share with can see every frozen corpse across all of your characters, and the name of each ' +
              'pilot it came from — live, until you stop sharing. Everything else in your hangars stays private.'
            }
          />
        </p>
      )}

      {corpses.length > 0 ? (
        <ul className={styles.grid}>
          {corpses.map(({ itemId, typeId, pilot, isNew }) => (
            <li key={itemId} className={styles.tile}>
              {isNew && <span className={styles.badge}>New!</span>}
              <TypeIcon id={typeId} size={48} className={styles.icon} />
              <span className={styles.name}>
                {pilot ?? <span className={styles.unknown}>Unknown (#{itemId})</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>No corpses in this collection.</p>
      )}
    </>
  )
}
export default CorpsesPage
