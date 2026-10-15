import { cache } from 'react'
import { match } from 'ts-pattern'

import { getSdeTypes } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { metaColor } from '../../../ship/[itemId]/card/cardModel'
import { logoPicture, portraitPicture, type SummaryCard } from '../../../summaryCard'
import { bposAccess, resolveBposSubject, type BposSubject } from '../../access'
import { fetchBpoEntries, fetchCorpBpoEntries } from '../../data'
import { characterSlug, pickMain } from '../../slug'
import { totalBpos } from '../../stack'
import { bposDescription, bpoStacks, uniqueOriginalsText } from './cardModel'

// Everything the link-preview card says about a blueprint library, for a
// visitor who is not signed in: a chat client fetching a preview. So only a
// fully public share or a signed ?share= link gets a card; a library shared
// with a corporation or alliance, or not at all, gets none, and the page's
// title stays the one derived from its URL alone.
export type BposCard = SummaryCard & { description: string }

const pictureOf = async (subject: BposSubject): Promise<SummaryCard['picture']> =>
  match(subject)
    .with({ kind: 'corporation' }, ({ corporationId }) => Promise.resolve(logoPicture(corporationId)))
    .with({ kind: 'account' }, async ({ registrations }) => {
      const main = pickMain(registrations)
      if (!main) return null
      const { data } = await createServiceClient()
        .from('registration')
        .select('character_id')
        .eq('id', main.id)
        .maybeSingle<{ character_id: number | string | null }>()
      return data?.character_id == null ? null : portraitPicture(data.character_id)
    })
    .exhaustive()

export const loadBposCard = cache(async (name: string, share?: string): Promise<BposCard | null> => {
  const slug = characterSlug(decodeURIComponent(name))
  const subject = await resolveBposSubject(slug, null)
  if (!subject) return null
  // No viewer, so the viewer's client is never asked; the service client
  // stands in for the parameter.
  const access = await bposAccess(subject, null, createServiceClient(), share)
  if (access == null) return null

  const subjectName = subject.kind === 'corporation' ? subject.name : subject.mainName
  const entries = await (subject.kind === 'corporation'
    ? fetchCorpBpoEntries(subject.corporationId)
    : fetchBpoEntries(subject.registrations.map((r) => r.id)))
  const [types, picture] = await Promise.all([getSdeTypes(entries.map((e) => e.typeId)), pictureOf(subject)])
  const total = totalBpos(entries)
  return {
    title: `The Blueprint Library of ${subjectName}`,
    subtitle: 'Blueprint originals',
    color: metaColor(null),
    picture,
    pictureLabel: subjectName,
    owner: null,
    stacks: bpoStacks(entries, types),
    emptyText: 'No blueprint originals',
    countText: entries.length > 0 ? uniqueOriginalsText(entries.length) : null,
    figure: total > 0 ? { label: 'Originals', text: String(total) } : null,
    description: bposDescription(subjectName, entries.length, total),
  }
})
