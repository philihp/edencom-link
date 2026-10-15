import type { Metadata, Viewport } from 'next'
import { notFound } from 'next/navigation'

import { shareCardMetadata } from '../../shareCardMetadata'
import { CARD_HEIGHT, CARD_WIDTH } from '../../ship/[itemId]/card/cardModel'
import { TypeIcon } from '../../typeIcon'
import { loadCorpseCollection } from '../collection'
import styles from '../corpses.module.css'
import { loadCorpsesCard } from './card/loadCard'

// Public share page — no login required. It reads through the service-role
// client (bypassing RLS), so every query is explicitly scoped to the owning
// account's characters (../collection.ts).
export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ characterID: string }> }

// The page is public, so it always carries the link preview a chat client
// unfurls (./card/loadCard.ts).
export const generateMetadata = async ({ params }: PageProps): Promise<Metadata> => {
  const { characterID } = await params
  const card = await loadCorpsesCard(characterID)
  if (!card) return {}
  return shareCardMetadata({
    title: card.title,
    typeName: card.title,
    description: card.description,
    imagePath: `/corpses/${characterID}/card`,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })
}

export const generateViewport = async ({ params }: PageProps): Promise<Viewport> => {
  const { characterID } = await params
  const card = await loadCorpsesCard(characterID)
  return card ? { themeColor: card.color } : {}
}

const CorpsesPage = async ({ params }: PageProps) => {
  const { characterID } = await params

  const collection = await loadCorpseCollection(characterID)
  if (!collection) notFound()
  const { accountName, corpses } = collection

  return (
    <>
      <div className={styles.pageHeader}>
        <h1>{accountName ? `The Many Corpses of ${accountName}` : 'The Many Corpses'}</h1>
        {corpses.length > 0 && <span className={styles.count}>{corpses.length}</span>}
      </div>

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
