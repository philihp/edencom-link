import { NextRequest } from 'next/server'

import { iconUrl } from '../../../iconVariation'
import { compactIsk } from '../../../ship/[itemId]/card/cardModel'
import { summaryCardResponse, type SummaryCard } from '../../../summaryCard'
import { itemCountText } from './cardModel'
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

// The line under the title: type and group, without repeating a title that
// already is the type name.
const subtitle = ({ title, typeName, groupName }: AssetCard): string =>
  [title === typeName ? null : typeName, groupName === typeName ? null : groupName]
    .filter((part) => part != null)
    .join(' · ')

const toSummary = (card: AssetCard): SummaryCard => ({
  title: card.title,
  subtitle: subtitle(card),
  color: card.color,
  picture: card.typeId == null ? null : { url: iconUrl(card.typeId, card.variation, 128), round: false },
  // A station or a solar system has no type art, so it says what it is.
  pictureLabel: card.typeName,
  owner: card.owner,
  stacks: card.stacks,
  emptyText: 'Empty',
  countText: card.itemCount > 0 ? itemCountText(card.itemCount) : null,
  figure:
    card.value.sell == null
      ? null
      : {
          label: card.value.unpriced > 0 ? 'Est. value (partial)' : 'Est. value',
          text: compactIsk(card.value.sell),
        },
})

export async function GET(request: NextRequest, { params }: { params: Promise<{ locationId: string }> }) {
  const { locationId } = await params
  const { searchParams } = new URL(request.url)
  const share = searchParams.get('share') ?? undefined
  const token = searchParams.get('token') ?? undefined
  if (!share && !token) return new Response('Not found', { status: 404 })

  const card = await loadAssetCard(locationId, share, token)
  if (!card) return new Response('Not found', { status: 404 })
  return summaryCardResponse(toSummary(card))
}
