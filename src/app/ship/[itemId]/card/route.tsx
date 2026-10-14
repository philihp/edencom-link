import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

import { CARD_CACHE_CONTROL, cardFonts, dataUri } from '../../../shareCardRender'
import { Card, type Images } from './cardImage'
import { CARD_HEIGHT, CARD_WIDTH } from './cardModel'
import { loadShipCard, type ShipCard } from './loadCard'

// The ship's link-preview image: what Discord, Slack and X show under a
// posted share link (the page's og:image points here). next/og draws the JSX
// in ./cardImage with Satori (JSX → SVG) and Resvg (SVG → PNG).
//
// Reached only with the same ?share= (or legacy ?token=) the page takes, and
// it answers 404 for anything that link does not open, so the image can never
// show more than the page does. Like the share page, it has no location.

// A card with no stored appraisal asks the provider, waits a few seconds, and
// lets the request finish after the response (loadCard.ts). The provider's
// queue can take most of a minute, so the function needs that long.
export const maxDuration = 60

const typeIconUrl = (typeId: number) => `https://images.evetech.net/types/${typeId}/icon?size=64`
const renderUrl = (typeId: number) => `https://images.evetech.net/types/${typeId}/render?size=512`

const fetchImages = async (card: ShipCard): Promise<Images> => {
  const iconIds = [...new Set(card.rows.flatMap((row) => row.icons.map((icon) => icon.typeId)))]
  const [render, portrait, ...icons] = await Promise.all([
    dataUri(renderUrl(card.hullTypeId)),
    card.owner.portrait ? dataUri(card.owner.portrait.url.replace('size=64', 'size=128')) : Promise.resolve(null),
    ...iconIds.map((id) => dataUri(typeIconUrl(id))),
  ])
  return { render, portrait, icons: new Map(iconIds.map((id, i) => [id, icons[i]])) }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params
  const { searchParams } = new URL(request.url)
  const share = searchParams.get('share') ?? undefined
  const token = searchParams.get('token') ?? undefined
  if (!share && !token) return new Response('Not found', { status: 404 })

  // The one caller allowed to ask the appraisal provider (see loadCard.ts).
  const card = await loadShipCard(itemId, share, token, true)
  if (!card) return new Response('Not found', { status: 404 })

  const [images, fonts] = await Promise.all([fetchImages(card), cardFonts()])
  return new ImageResponse(<Card card={card} images={images} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts,
    headers: { 'Cache-Control': CARD_CACHE_CONTROL },
  })
}
