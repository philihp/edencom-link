import { cache } from 'react'

import { metaColor } from '../../../ship/[itemId]/card/cardModel'
import type { SummaryCard } from '../../../summaryCard'
import { resolveLink } from '../../access'
import { topLevelFieldOf } from '../../validate'
import { linkDescription, linkSubtitle } from './cardModel'

// The link-preview card for a Link: its name and what it reads. The card
// never runs the query. A chat client fetching a preview must not spend the
// creator's query budget, and the results are the creator's data, which
// belong on the page the link opens rather than in a cached image. It does not
// name the creator either, as the page does not.
//
// resolveLink is the page's own door: a fully public Link through RLS (a chat
// client is signed out), or a signed ?share= link. Anything else gets no card.
export type LinkCard = SummaryCard & { description: string }

export const loadLinkCard = cache(async (id: string, share?: string): Promise<LinkCard | null> => {
  const resolved = await resolveLink(id, share)
  if (!resolved) return null
  const { link } = resolved
  const field = topLevelFieldOf(link.query)
  return {
    title: link.name,
    subtitle: linkSubtitle(field),
    color: metaColor(null),
    picture: null,
    pictureLabel: 'Link',
    owner: null,
    stacks: [],
    emptyText: 'Live results from EVE Online, current when the link is opened.',
    countText: null,
    figure: null,
    description: linkDescription(link.name, field),
  }
})
