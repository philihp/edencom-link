import { NextRequest } from 'next/server'

import { summaryCardResponse } from '../../../summaryCard'
import { loadCorpsesCard } from './loadCard'

// A corpse collection's link-preview image. The page's og:image points here.
// The page is public, so this is too; an unknown character is a 404.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ characterID: string }> }) {
  const { characterID } = await params
  const card = await loadCorpsesCard(characterID)
  if (!card) return new Response('Not found', { status: 404 })
  return summaryCardResponse(card)
}
