import { NextRequest } from 'next/server'

import { shipCardResponse } from '../../../../ship/[itemId]/card/cardImage'
import { loadFittingCard } from './loadCard'

// A saved fitting's link-preview image: the ship card, drawn for the fit. The
// page's og:image points here. Reached only with the same signed ?share= the
// page takes, and a 404 for anything that link does not open.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ characterId: string; fittingId: string }> }
) {
  const { characterId, fittingId } = await params
  const share = new URL(request.url).searchParams.get('share') ?? undefined
  const card = await loadFittingCard(characterId, fittingId, share)
  if (!card) return new Response('Not found', { status: 404 })
  return shipCardResponse(card)
}
