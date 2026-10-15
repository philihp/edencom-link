import { cache } from 'react'

import { metaColor } from '../../../ship/[itemId]/card/cardModel'
import { portraitPicture, type SummaryCard } from '../../../summaryCard'
import { loadCorpseCollection } from '../../collection'
import { corpseCountText, corpsesDescription, corpseStacks } from '../../corpse'

// The link-preview card for a corpse collection: the account's main, a
// count, and the corpses by type. The page is public, so the card is too, and
// it reads the same collection the page lists.
export type CorpsesCard = SummaryCard & { description: string }

export const loadCorpsesCard = cache(async (characterID: string): Promise<CorpsesCard | null> => {
  const collection = await loadCorpseCollection(characterID)
  if (!collection) return null
  const { accountName, accountCharacterId, corpses } = collection
  const fresh = corpses.filter((c) => c.isNew).length
  return {
    title: accountName ? `The Many Corpses of ${accountName}` : 'The Many Corpses',
    subtitle: 'Frozen corpses',
    color: metaColor(null),
    picture: accountCharacterId == null ? null : portraitPicture(accountCharacterId),
    pictureLabel: 'Corpses',
    owner: null,
    stacks: corpseStacks(corpses),
    emptyText: 'No corpses yet',
    countText: fresh > 0 ? `${fresh} new` : null,
    figure: corpses.length > 0 ? { label: 'Collected', text: corpseCountText(corpses.length) } : null,
    description: corpsesDescription(accountName, corpses),
  }
})
