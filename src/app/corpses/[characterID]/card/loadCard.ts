import { cache } from 'react'

import { createServiceClient } from '@/utils/supabase/service'

import { metaColor } from '../../../ship/[itemId]/card/cardModel'
import { portraitPicture, type SummaryCard } from '../../../summaryCard'
import { corpseAccess, resolveCorpseSubject } from '../../access'
import { loadCorpseCollection } from '../../collection'
import { corpseCountText, corpsesDescription, corpseStacks } from '../../corpse'

// The link-preview card for a corpse collection: the account's main, a count,
// and the corpses by type.
//
// The reader is a chat client fetching a preview, which carries no session. So
// only a fully public collection or one a signed ?share= link opens gets a
// card; a collection shared with a corporation or alliance, or not shared at
// all, gets none.
export type CorpsesCard = SummaryCard & { description: string }

export const loadCorpsesCard = cache(async (characterID: string, share?: string): Promise<CorpsesCard | null> => {
  const subject = await resolveCorpseSubject(characterID)
  if (!subject) return null
  // No viewer, so the viewer's client is never asked; the service client
  // stands in for the parameter.
  const access = await corpseAccess(subject, null, createServiceClient(), share)
  if (access == null) return null

  const collection = await loadCorpseCollection(characterID)
  if (!collection) return null
  const { accountName, accountCharacterId, corpses } = collection
  const fresh = corpses.filter((c) => c.isNew).length
  return {
    title: `The Many Corpses of ${accountName}`,
    subtitle: 'Frozen corpses',
    color: metaColor(null),
    picture: portraitPicture(accountCharacterId),
    pictureLabel: 'Corpses',
    owner: null,
    stacks: corpseStacks(corpses),
    emptyText: 'No corpses yet',
    countText: fresh > 0 ? `${fresh} new` : null,
    figure: corpses.length > 0 ? { label: 'Collected', text: corpseCountText(corpses.length) } : null,
    description: corpsesDescription(accountName, corpses),
  }
})
