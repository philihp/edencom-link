import type { SupabaseClient, User } from '@supabase/supabase-js'
import { cache } from 'react'

import { createServiceClient } from '@/utils/supabase/service'

import { pickMain } from '../bpos/slug'
import { shareAccess, type ShareAccess, type ShareRow } from '../shareLadder'

// Who the /corpses/[characterID] URL names, and who is allowed to look.
//
// The subject is an ACCOUNT: the collection pools every corpse across every
// character on it, the way /bpos pools blueprint originals. So, like /bpos,
// the URL addresses the account by its MAIN and only its main. An alt's id
// resolving here would hand an anonymous visitor the main's name, and two ids
// rendering one page would prove a shared owner — which is the correlation the
// world-readable character_directory deliberately carries no user_id to allow.
//
// Everything below reads through the service role (the page does too), so
// authorization is this module's job rather than RLS's.

export type CorpseSubject = {
  userId: string
  // Every character on the account: the scope of the corpse read. Only the
  // main is ever named on the page.
  registrationIds: string[]
  mainName: string
  mainCharacterId: string
}

type RegistrationRow = {
  id: string
  user_id: string
  character_id: number | string | null
  name: string
  is_main: boolean | null
  created_at: string | null
}

const REGISTRATION_COLUMNS = 'id, user_id, character_id, name, is_main, created_at'

// Character id → the account whose MAIN character carries it, or null. Two
// hops: the registration naming that character, then its whole account, whose
// own main is recomputed and compared. A character that merely belongs to the
// account but isn't its main answers nothing — the URL means "this person",
// and a person is their main.
//
// Cached per request: the page's body, metadata and viewport all ask.
export const resolveCorpseSubject = cache(async (characterID: string): Promise<CorpseSubject | null> => {
  if (!/^\d+$/.test(characterID)) return null
  const service = createServiceClient()

  const { data: owner } = await service
    .from('registration')
    .select('user_id')
    .eq('character_id', characterID)
    .limit(1)
    .maybeSingle<{ user_id: string }>()
  if (!owner) return null

  const { data: rows } = await service
    .from('registration')
    .select(REGISTRATION_COLUMNS)
    .eq('user_id', owner.user_id)
    .returns<RegistrationRow[]>()

  const registrations = rows ?? []
  const main = pickMain(registrations)
  if (!main || String(main.character_id) !== String(characterID)) return null

  return {
    userId: owner.user_id,
    registrationIds: registrations.map((r) => r.id),
    mainName: main.name,
    mainCharacterId: String(main.character_id),
  }
})

// How the viewer got in, or null if they didn't. The owner always sees their
// own page — that's where the share dialog lives — so they're checked before
// any share row is read.
export type CorpseAccess = 'owner' | ShareAccess

export const canManageCorpseShare = (access: CorpseAccess): boolean => access === 'owner'

export const corpseAccess = async (
  subject: CorpseSubject,
  viewer: User | null,
  // The viewer's own cookie-session client: the audience check runs as them, so
  // the membership test is Postgres's (share_audience_matches) rather than a
  // second implementation here.
  viewerClient: SupabaseClient,
  shareParam: string | undefined
): Promise<CorpseAccess | null> => {
  if (viewer?.id === subject.userId) return 'owner'

  const { data: share } = await createServiceClient()
    .from('corpse_share')
    .select('id, corporation_ids, alliance_ids, secret')
    .eq('user_id', subject.userId)
    .maybeSingle<ShareRow>()

  return shareAccess(share, viewer, shareParam, async () => {
    const { data } = await viewerClient
      .from('corpse_share')
      .select('id')
      .eq('user_id', subject.userId)
      .maybeSingle<{ id: string }>()
    return data != null
  })
}
