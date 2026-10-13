'use server'

import { revalidatePath } from 'next/cache'

import { mintShareSecret, signShare, tokenSalt } from '@/shareToken'
import { createClient } from '@/utils/supabase/server'
import type { SaveShareInput, SaveShareResult } from './shareActions'

// Create/update/revoke a CORPORATION's asset share for one item — the writer
// behind the share dialog on a corp hangar item (docs/sharing-layer/14-corp-asset-share.md,
// PR 4). The twins of shareActions.ts, with the one difference the subject
// forces: the row belongs to the corporation, so any member may change or stop
// it, and `created_by` only records who first did.
//
// Cookie-session client like every share writer here, never the service role:
// RLS scopes the reads to the caller and the share table's own policies pin
// corporation_id to a corporation they have a character in.

// Membership + audience guard shared by save/revoke. Three things come out of
// it: the item's corporation (which must be one of the caller's — visibility is
// not membership, since PR 3 made a shared corp item readable by its audience),
// one of the caller's own registrations IN that corporation for the audit
// column, and the audiences they may aim a share at, so a hand-rolled request
// cannot aim one at a third party.
const ownCorpItem = async (supabase: Awaited<ReturnType<typeof createClient>>, itemId: string) => {
  const [{ data: item }, { data: regs }] = await Promise.all([
    supabase
      .from('corp_asset')
      .select('item_id, corporation_id')
      .eq('item_id', itemId)
      .maybeSingle<{ item_id: number | string; corporation_id: number | string }>(),
    supabase.from('registration').select('id, corporation_id'),
  ])
  if (!item) return null
  const own = (regs ?? []) as Array<{ id: string; corporation_id: number | string | null }>
  const corporationId = Number(item.corporation_id)
  const author = own.find((r) => r.corporation_id != null && Number(r.corporation_id) === corporationId)
  if (!author) return null

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
  return {
    corporationId,
    authorRegistrationId: author.id,
    ownCorpIds: new Set(corpIds),
    ownAllianceIds: new Set(allianceIds),
  }
}

export const saveCorpAssetShare = async (itemId: string, input: SaveShareInput): Promise<SaveShareResult> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  const owned = await ownCorpItem(supabase, itemId)
  if (!owned) return { error: 'Not your corporation’s item' }

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
    .from('corp_asset_share')
    .select('id, secret')
    .eq('corporation_id', owned.corporationId)
    .eq('item_id', itemId)
    .maybeSingle<{ id: string; secret: string | null }>()

  const secret = link ? (input.rotateLink || !existing?.secret ? mintShareSecret() : existing.secret) : null
  const audience = { corporation_ids: corporationIds, alliance_ids: allianceIds, secret }

  // Insert and update are separate rather than one upsert: `created_by` names
  // whoever first shared the item, and editing a corpmate's share must not
  // rewrite that.
  const { data: saved, error } = existing
    ? await supabase.from('corp_asset_share').update(audience).eq('id', existing.id).select('id').maybeSingle<{
        id: string
      }>()
    : await supabase
        .from('corp_asset_share')
        .insert({
          corporation_id: owned.corporationId,
          created_by: owned.authorRegistrationId,
          item_id: Number(itemId),
          ...audience,
        })
        .select('id')
        .maybeSingle<{ id: string }>()
  if (error || !saved) return { error: error?.message ?? 'Save failed' }

  revalidatePath(`/ship/${itemId}`)
  revalidatePath(`/asset/${itemId}`)

  return {
    share: {
      corporationIds,
      allianceIds,
      hasLink: secret != null,
      shareParam: secret != null && salt != null ? signShare(saved.id, secret, salt) : null,
      isPublic: secret == null && corporationIds.length === 0 && allianceIds.length === 0,
    },
  }
}

export const revokeCorpAssetShare = async (itemId: string): Promise<{ error?: string }> => {
  const supabase = await createClient()

  const { data: auth, error: userError } = await supabase.auth.getUser()
  if (userError || !auth?.user) return { error: 'Not signed in' }

  // RLS scopes the delete to corporations the caller has a character in, so a
  // member can stop a share a corpmate started — the point of the corp grantor.
  const { error } = await supabase.from('corp_asset_share').delete().eq('item_id', itemId)
  if (error) return { error: error.message }

  revalidatePath(`/ship/${itemId}`)
  revalidatePath(`/asset/${itemId}`)
  return {}
}
