import type { Metadata, Viewport } from 'next'

import { shareCardMetadata, shareQuery } from '../../../shareCardMetadata'
import { CARD_HEIGHT, CARD_WIDTH } from '../../../ship/[itemId]/card/cardModel'
import { shipShareMetadata, shipShareViewport } from '../../../ship/[itemId]/card/metadata'
import { loadAssetCard } from './loadCard'

// A share link to /asset/<id>'s preview tags: the container card (./route.tsx)
// for anything that is not a ship, else the ship's own card. The page
// redirects a ship to /ship/<id>, but only after its head is out, and a chat
// client unfurls the head it got rather than following a redirect in the body.
// A place share (station, structure, system) gets the same card, drawn for the
// place. Only a share link gets one, and only when it opens something.
export const assetShareMetadata = async (itemId: string, share?: string, token?: string): Promise<Metadata> => {
  if (!share && !token) return {}
  const card = await loadAssetCard(itemId, share, token)
  if (!card) return shipShareMetadata(itemId, share, token)
  return shareCardMetadata({
    title: card.title,
    typeName: card.typeName,
    description: card.description,
    imagePath: `/asset/${itemId}/card?${shareQuery({ share, token })}`,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })
}

// Discord colours the embed's side stripe from theme-color: the container's
// quality tier, as the card's border.
export const assetShareViewport = async (itemId: string, share?: string, token?: string): Promise<Viewport> => {
  if (!share && !token) return {}
  const card = await loadAssetCard(itemId, share, token)
  return card ? { themeColor: card.color } : shipShareViewport(itemId, share, token)
}
