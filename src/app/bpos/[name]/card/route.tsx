import { NextRequest } from 'next/server'

import { summaryCardResponse } from '../../../summaryCard'
import { loadBposCard } from './loadCard'

// A blueprint library's link-preview image. The page's og:image points here.
// It answers only what a signed-out visitor could open: a fully public library,
// or one a signed ?share= link opens. Anything else is a 404.
export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params
  const share = new URL(request.url).searchParams.get('share') ?? undefined
  const card = await loadBposCard(name, share)
  if (!card) return new Response('Not found', { status: 404 })
  return summaryCardResponse(card)
}
