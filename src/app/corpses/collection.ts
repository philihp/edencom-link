import { cache } from 'react'

import { searchSdeTypesAll } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

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

type RegistrationRow = {
  id: string
  user_id: string
  character_id: number | string | null
  name: string
  is_main: boolean
}

type CorpseRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  valid_from: string | null
}

export type CorpseCollection = {
  // The account's main character, else the character in the URL, else any.
  accountName: string | null
  accountCharacterId: number | string | null
  corpses: Corpse[]
}

// Reads through the service-role client (bypassing RLS), so every query is
// explicitly scoped to the owning account's characters. Null when no account
// holds the character in the URL. Cached per request, since the page's
// metadata, viewport and body all ask.
export const loadCorpseCollection = cache(async (characterID: string): Promise<CorpseCollection | null> => {
  if (!/^\d+$/.test(characterID)) return null
  const service = createServiceClient()

  // Which account owns the character in the URL? Its registrations give us the
  // full set of characters whose corpses we list.
  const { data: owner } = await service
    .from('registration')
    .select('user_id')
    .eq('character_id', characterID)
    .limit(1)
    .maybeSingle<Pick<RegistrationRow, 'user_id'>>()
  if (!owner) return null

  // Every character on the account, for both the corpse scope and the label.
  const { data: registrations } = await service
    .from('registration')
    .select('id, user_id, character_id, name, is_main')
    .eq('user_id', owner.user_id)
    .returns<RegistrationRow[]>()
  const rows = registrations ?? []

  // The asset tables key on the registration row's uuid
  // (character_asset.registration_id → registration.id), not the EVE character
  // id, so scope the corpse query by those uuids.
  const registrationIds = rows.map((r) => r.id)

  // Label the account by its main character, falling back to the character in
  // the URL, then any character on the account.
  const named =
    rows.find((r) => r.is_main) ?? rows.find((r) => String(r.character_id) === String(characterID)) ?? rows[0] ?? null

  const typeIds = await corpseTypeIds()

  const { data: corpseRows } =
    registrationIds.length && typeIds.length
      ? await service
          .from('character_asset')
          .select('item_id, type_id, name, valid_from')
          .in('registration_id', registrationIds)
          .in('type_id', typeIds)
          .returns<CorpseRow[]>()
      : { data: [] as CorpseRow[] }

  const now = Date.now()
  return {
    accountName: named?.name ?? null,
    accountCharacterId: named?.character_id ?? null,
    corpses: (corpseRows ?? [])
      .map((r) => toCorpse(r, now))
      .sort((a, b) => (a.pilot ?? '').localeCompare(b.pilot ?? '', undefined, { sensitivity: 'base' })),
  }
})
