import type { Metadata, Viewport } from 'next'

import { shareCardMetadata, shareQuery } from '../../../shareCardMetadata'
import { CARD_HEIGHT, CARD_WIDTH } from './cardModel'
import { loadShipCard } from './loadCard'

// A ship share link's preview tags. The ship page sets them, and so does the
// asset page when the id it was opened on is a ship: /asset/<id> redirects a
// ship here, but a chat client reads the asset page's head before it would
// follow that redirect. Only a share link gets one — the signed-in page is
// private, and a chat client fetching it is not signed in anyway. Empty when
// the link opens no ship.
export const shipShareMetadata = async (itemId: string, share?: string, token?: string): Promise<Metadata> => {
  if (!share && !token) return {}
  const card = await loadShipCard(itemId, share, token)
  if (!card) return {}
  return shareCardMetadata({
    title: card.title,
    typeName: card.typeName,
    description: card.description,
    imagePath: `/ship/${itemId}/card?${shareQuery({ share, token })}`,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })
}

// Discord colours the embed's side stripe from theme-color: the hull's
// quality tier, as the card's border.
export const shipShareViewport = async (itemId: string, share?: string, token?: string): Promise<Viewport> => {
  if (!share && !token) return {}
  const card = await loadShipCard(itemId, share, token)
  return card ? { themeColor: card.color } : {}
}
