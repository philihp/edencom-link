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
}

export type SaveShareResult = { error?: string; share?: ShareState }

// Ownership + audience guard shared by save/revoke: the item must belong to
// one of the CALLER's registrations (visibility isn't ownership — shared
// items are RLS-visible to their audience too), and requested audience ids
// are filtered to ones the caller actually has, so a hand-rolled request
// can't aim a share at a third party (the setSharedAlliances defense).
const ownItem = async (supabase: Awaited<ReturnType<typeof createClient>>, itemId: string) => {
  const [{ data: item }, { data: regs }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, registration_id')
      .eq('item_id', itemId)
      .maybeSingle<{ item_id: number | string; registration_id: string }>(),
    supabase.from('registration').select('id, corporation_id'),
  ])
  const own = (regs ?? []) as Array<{ id: string; corporation_id: number | string | null }>
  if (!item || !own.some((r) => r.id === item.registration_id)) return null
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
  return { registrationId: item.registration_id, ownCorpIds: new Set(corpIds), ownAllianceIds: new Set(allianceIds) }
}

export const saveAssetShare = async (itemId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const owned = await ownItem(supabase, itemId)
  if (!owned) return { error: 'Not your item' }

  const corporationIds = input.isPublic
    ? []
    : [...new Set(input.corporationIds.map(Number))].filter((id) => owned.ownCorpIds.has(id))
  const allianceIds = input.isPublic
    ? []
    : [...new Set(input.allianceIds.map(Number))].filter((id) => owned.ownAllianceIds.has(id))
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
    .eq('registration_id', owned.registrationId)
    .eq('item_id', itemId)
    .maybeSingle<{ id: string; secret: string | null }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null

  const { data: saved, error } = await supabase
    .from('character_asset_share')
    .upsert(
      {
        registration_id: owned.registrationId,
        item_id: Number(itemId),
        corporation_ids: corporationIds,
        alliance_ids: allianceIds,
        secret,
      },
      { onConflict: 'registration_id,item_id' }
    )
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  // The dialog supersedes old-style links: saving retires any legacy
  // shared_asset_token row the caller still has for this item (RLS-scoped).
  await supabase.from('shared_asset_token').delete().eq('item_id', itemId)

  revalidatePath(`/ship/${itemId}`)
  revalidatePath(`/asset/${itemId}`)

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? `${saved.id}.${signShare(saved.id, secret, salt)}` : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0,
    },
  }
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
