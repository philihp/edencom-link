import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ImageResponse } from 'next/og'
import { NextRequest } from 'next/server'

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

// Chat clients keep their own copy of an embed, so this only bounds how long
// our CDN keeps serving a card after the share is revoked or the fit changes.
const CACHE_CONTROL = 'public, max-age=600, s-maxage=600'

// Read once per process. The fonts are traced into the function bundle by
// outputFileTracingIncludes in next.config.mjs.
const font = (file: string) => readFile(join(process.cwd(), 'public/fonts', file))
let fonts: Promise<Buffer[]> | null = null
const loadFonts = () =>
  (fonts ??= Promise.all([
    font('evesansneue-regular.otf'),
    font('evesansneue-bold.otf'),
    font('evesansneue-expandedbold.otf'),
  ]))

// Satori would fetch each <img> itself and fail the whole card on one bad
// answer. So the route fetches them first, with a time limit, and a picture
// that does not arrive leaves an empty frame rather than no card.
const dataUri = async (url: string): Promise<string | null> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
    if (!response.ok) return null
    const type = response.headers.get('content-type') ?? 'image/png'
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  } catch {
    return null
  }
}

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

  const [images, [regular, bold, expandedBold]] = await Promise.all([fetchImages(card), loadFonts()])
  return new ImageResponse(<Card card={card} images={images} />, {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    fonts: [
      { name: 'Eve Sans Neue', data: regular, weight: 400, style: 'normal' },
      { name: 'Eve Sans Neue', data: bold, weight: 700, style: 'normal' },
      { name: 'Eve Sans Neue Expanded', data: expandedBold, weight: 700, style: 'normal' },
    ],
    headers: { 'Cache-Control': CACHE_CONTROL },
  })
}
