import { NextRequest } from 'next/server'

import { summaryCardResponse } from '../../../summaryCard'
import { loadLinkCard } from './loadCard'

// A Link's link-preview image. The page's og:image points here. It opens what
// the page opens for the same visitor and ?share=, and is a 404 otherwise.
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const share = new URL(request.url).searchParams.get('share') ?? undefined
  const card = await loadLinkCard(id, share)
  if (!card) return new Response('Not found', { status: 404 })
  return summaryCardResponse(card)
}
