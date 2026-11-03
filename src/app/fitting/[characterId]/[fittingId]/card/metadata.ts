import type { Metadata, Viewport } from 'next'

import { shareCardMetadata, shareCardPath } from '../../../../shareCardMetadata'
import { CARD_HEIGHT, CARD_WIDTH } from '../../../../ship/[itemId]/card/cardModel'
import { loadFittingCard } from './loadCard'

// A fitting share's preview tags: a signed link's, or the bare URL's for a fit
// shared with everyone. Empty for anything else: the signed-in page is the
// owner's or an audience's, and a chat client is neither.
export const fittingShareMetadata = async (
  characterId: string,
  fittingId: string,
  share?: string
): Promise<Metadata> => {
  const card = await loadFittingCard(characterId, fittingId, share)
  if (!card) return {}
  return shareCardMetadata({
    title: card.title,
    typeName: card.typeName,
    description: card.description,
    imagePath: shareCardPath(`/fitting/${characterId}/${fittingId}/card`, { share }),
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  })
}

// Discord colours the embed's side stripe from theme-color: the hull's tier.
export const fittingShareViewport = async (
  characterId: string,
  fittingId: string,
  share?: string
): Promise<Viewport> => {
  const card = await loadFittingCard(characterId, fittingId, share)
  return card ? { themeColor: card.color } : {}
}
