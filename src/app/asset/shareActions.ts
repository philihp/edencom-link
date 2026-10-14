'use server'

import { revalidatePath } from 'next/cache'

import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import type { ShareState } from './shareData'

// Create/update/revoke the caller's asset share for one item — the writer
// behind the share dialog (docs/sharing-layer/03-share-dialog.md). Cookie-
// session client like every share writer in this codebase, never the service
// role: RLS scopes the reads to the caller and the share table's own policies
// pin registration_id to their registrations.

export type SaveShareInput = {
  corporationIds: number[]
  allianceIds: number[]
  link: boolean
  // Mint a fresh secret even if one exists — every previously issued URL dies.
  rotateLink: boolean
  isPublic: boolean
  // Show the account's main character as the owner (asset shares only).
  showAsMain?: boolean
}

export type SaveShareResult = { error?: string; share?: ShareState }

type Supabase = Awaited<ReturnType<typeof createClient>>
type OwnRegistration = { id: string; corporation_id: number | string | null }
type Grant = { registrationId: string; ownCorpIds: Set<number>; ownAllianceIds: Set<number> }

const ownRegistrations = async (supabase: Supabase): Promise<OwnRegistration[]> => {
  const { data } = await supabase.from('registration').select('id, corporation_id')
  return (data ?? []) as OwnRegistration[]
}

// The audiences a share may be aimed at: the corporations the caller's
// characters are in and those corporations' alliances. Requested ids are
// filtered to these, so a hand-rolled request can't aim a share at a third
// party (the setSharedAlliances defense).
const ownAudiences = async (supabase: Supabase, own: OwnRegistration[]) => {
  const corpIds = [
    ...new Set(
      own
        .map((r) => r.corporation_id)
        .filter((c): c is number => c != null)
        .map(Number)
    ),
  ]
  const { data: corps } = corpIds.length
    ? await supabase.from('corporation').select('corporation_id, alliance_id').in('corporation_id', corpIds)
    : { data: [] }
  const allianceIds = [
    ...new Set(
      ((corps ?? []) as Array<{ alliance_id: number | string | null }>)
        .map((c) => c.alliance_id)
        .filter((a): a is number => a != null)
        .map(Number)
    ),
  ]
  return { ownCorpIds: new Set(corpIds), ownAllianceIds: new Set(allianceIds) }
}

// Ownership guard for an ITEM share: the item must belong to one of the
// CALLER's registrations (visibility isn't ownership — shared items are
// RLS-visible to their audience too), and that registration is the grantor.
const ownItem = async (supabase: Supabase, itemId: string): Promise<Grant | null> => {
  const [{ data: item }, own] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id')
      .eq('item_id', itemId)
      .maybeSingle<{ item_id: number | string; registration_id: string }>(),
    ownRegistrations(supabase),
  ])
  if (!item || !own.some((r) => r.id === item.registration_id)) return null
  return { registrationId: item.registration_id, ...(await ownAudiences(supabase, own)) }
}

// Grantor guard for a PLACE share (docs/sharing-layer/15-place-share.md): the
// named registration must be one of the caller's. Nothing about the place is
// checked, nor need be — the share covers only that character's own items
// there, so a place they hold nothing at simply shows nothing.
const ownGrantor = async (supabase: Supabase, registrationId: string): Promise<Grant | null> => {
  const own = await ownRegistrations(supabase)
  if (!own.some((r) => r.id === registrationId)) return null
  return { registrationId, ...(await ownAudiences(supabase, own)) }
}

// The one write, for an item or a place: upsert the grantor's row for the
// subject id with the audiences the caller may name.
const writeAssetShare = async (
  supabase: Supabase,
  grant: Grant,
  subjectId: string,
  input: SaveShareInput
): Promise<SaveShareResult> => {
  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => grant.ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => grant.ownAllianceIds.has(id))
  const link = input.isPublic ? false : input.link

  // Signing requires the deployment's salt; fail before writing anything.
  let salt: string | null = null
  if (link) {
    try {
      salt = tokenSalt()
    } catch {
      return { error: 'Share links are unavailable: TOKEN_SALT is not configured.' }
    }
  }

  const { data: existing } = await supabase
    .from('character_asset_share')
    .select('id, secret')
    .eq('registration_id', grant.registrationId)
    .eq('item_id', subjectId)
    .maybeSingle<{ id: string; secret: string | null }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null

  const { data: saved, error } = await supabase
    .from('character_asset_share')
    .upsert(
      {
        registration_id: grant.registrationId,
        item_id: Number(subjectId),
        corporation_ids: corporationIds,
        alliance_ids: allianceIds,
        secret,
        show_as_main: input.showAsMain === true,
      },
      { onConflict: 'registration_id,item_id' }
    )
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath(`/ship/${subjectId}`)
  revalidatePath(`/asset/${subjectId}`)

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? signShare(saved.id, secret, salt) : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0,
      showAsMain: input.showAsMain === true,
    },
  }
}

export const saveAssetShare = async (itemId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const owned = await ownItem(supabase, itemId)
  if (!owned) return { error: 'Not your item' }

  const result = await writeAssetShare(supabase, owned, itemId, input)
  // The dialog supersedes old-style links: saving retires any legacy
  // shared_asset_token row the caller still has for this item (RLS-scoped).
  if (result.share) await supabase.from('shared_asset_token').delete().eq('item_id', itemId)
  return result
}

// A character's items at a place, shared as one live list.
export const savePlaceShare = async (
  registrationId: string,
  placeId: string,
  input: SaveShareInput
): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const grant = await ownGrantor(supabase, registrationId)
  if (!grant) return { error: 'Not your character' }

  return writeAssetShare(supabase, grant, placeId, input)
}

// Stops one character's place share. Scoped to the grantor, since several of
// the account's characters may each share their own items at the same place.
export const revokePlaceShare = async (registrationId: string, placeId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes the delete to the caller's own rows.
  const { error } = await supabase
    .from('character_asset_share')
    .delete()
    .eq('registration_id', registrationId)
    .eq('item_id', placeId)
  if (error) return { error: error.message }

  revalidatePath(`/asset/${placeId}`)
  return {}
}

export const revokeAssetShare = async (itemId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes both deletes to the caller's own rows.
  const { error } = await supabase.from('character_asset_share').delete().eq('item_id', itemId)
  if (error) return { error: error.message }
  await supabase.from('shared_asset_token').delete().eq('item_id', itemId)

  revalidatePath(`/ship/${itemId}`)
  revalidatePath(`/asset/${itemId}`)
  return {}
}
