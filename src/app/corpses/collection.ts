import { cache } from 'react'

import { searchSdeTypesAll } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { resolveCorpseSubject } from './access'
import { type Corpse, toCorpse } from './corpse'

// One account's corpse collection, as the public /corpses/[characterID] page
// and its link-preview card both show it.
//
// Modern capsuleer corpses are the gendered "Corpse Male"/"Corpse Female"
// types; "Corpse" is the legacy generic. They're singleton items, so the
// extract job resolves each one's ESI asset name, which for a corpse reads
// "<pilot>'s Frozen Corpse". Match on the SDE type name rather than a
// hardcoded id so a game patch adding a variant is picked up automatically
// (and NPC "…Frozen Corpse" types, which aren't named exactly this, stay out).
const CORPSE_TYPE_NAMES = new Set(['corpse', 'corpse male', 'corpse female'])

const corpseTypeIds = async (): Promise<number[]> =>
  (await searchSdeTypesAll('corpse')).filter((t) => CORPSE_TYPE_NAMES.has(t.name.toLowerCase())).map((t) => t.typeID)

type CorpseRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  valid_from: string | null
}

export type CorpseCollection = {
  // The account's main character — the one the URL names, and the only
  // character this page ever identifies.
  accountName: string
  accountCharacterId: string
  corpses: Corpse[]
}

// Reads through the service-role client (bypassing RLS), so the query is
// explicitly scoped to the account's own registrations. Null when the URL
// names no account's main; WHETHER A VISITOR MAY SEE IT is a separate question
// (./access.ts), and every caller asks that too. Cached per request, since the
// page's metadata, viewport and body all ask.
export const loadCorpseCollection = cache(async (characterID: string): Promise<CorpseCollection | null> => {
  const subject = await resolveCorpseSubject(characterID)
  if (!subject) return null

  const typeIds = await corpseTypeIds()

  // The asset tables key on the registration row's uuid
  // (character_asset.registration_id → registration.id), not the EVE character
  // id, so scope the corpse query by those uuids.
  const { data: corpseRows } =
    subject.registrationIds.length && typeIds.length
      ? await createServiceClient()
          .from('character_asset')
          .select('item_id, type_id, name, valid_from')
          .in('registration_id', subject.registrationIds)
          .in('type_id', typeIds)
          .returns<CorpseRow[]>()
      : { data: [] as CorpseRow[] }

  const now = Date.now()
  return {
    accountName: subject.mainName,
    accountCharacterId: subject.mainCharacterId,
    corpses: (corpseRows ?? [])
      .map((r) => toCorpse(r, now))
      .sort((a, b) => (a.pilot ?? '').localeCompare(b.pilot ?? '', undefined, { sensitivity: 'base' })),
  }
})
