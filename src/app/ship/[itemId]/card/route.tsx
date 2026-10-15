import { NextRequest } from 'next/server'

import { shipCardResponse } from './cardImage'
import { loadShipCard } from './loadCard'

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

export async function GET(request: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params
  const { searchParams } = new URL(request.url)
  const share = searchParams.get('share') ?? undefined
  const token = searchParams.get('token') ?? undefined
  if (!share && !token) return new Response('Not found', { status: 404 })

  // The one caller allowed to ask the appraisal provider (see loadCard.ts).
  const card = await loadShipCard(itemId, share, token, true)
  if (!card) return new Response('Not found', { status: 404 })

  return shipCardResponse(card)
}
