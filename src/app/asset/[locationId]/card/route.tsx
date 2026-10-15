import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

import { iconUrl } from '../../../iconVariation'
import { CARD_CACHE_CONTROL, cardFonts, dataUri } from '../../../shareCardRender'
import { CARD_HEIGHT, CARD_WIDTH } from '../../../ship/[itemId]/card/cardModel'
import { Card, iconKey, type Images } from './cardImage'
import { type AssetCard, loadAssetCard } from './loadCard'

// A container's link-preview image: what Discord, Slack and X show under a
// posted share link to /asset/<id> (the page's og:image points here). The
// ship card's twin (ship/[itemId]/card/route.tsx), for anything that is not a
// ship, or for a place a share names (a station, structure or solar system).
//
// Reached only with the same ?share= (or legacy ?token=) the page takes, and
// it answers 404 for anything that link does not open, so the image can never
// show more than the page does. Like the share page, it has no location —
// unless the location is what was shared.

const fetchImages = async (card: AssetCard): Promise<Images> => {
  const stacks = [...new Map(card.stacks.map((stack) => [iconKey(stack), stack])).values()]
  const [picture, portrait, ...icons] = await Promise.all([
    card.typeId == null ? Promise.resolve(null) : dataUri(iconUrl(card.typeId, card.variation, 128)),
    card.owner.portrait ? dataUri(card.owner.portrait.url.replace('size=64', 'size=128')) : Promise.resolve(null),
    ...stacks.map((stack) => dataUri(iconUrl(stack.typeId, stack.variation, 64))),
  ])
  return { picture, portrait, icons: new Map(stacks.map((stack, i) => [iconKey(stack), icons[i]])) }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params
  const { searchParams } = new URL(request.url)
  const share = searchParams.get('share') ?? undefined
  const token = searchParams.get('token') ?? undefined
  if (!share && !token) return new Response('Not found', { status: 404 })

  const card = await loadAssetCard(locationId, share, token)
  if (!card) return new Response('Not found', { status: 404 })

  const [images, fonts] = await Promise.all([fetchImages(card), cardFonts()])
  return new ImageResponse(<Card card={card} images={images} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
    headers: { 'Cache-Control': CARD_CACHE_CONTROL },
  })
}
