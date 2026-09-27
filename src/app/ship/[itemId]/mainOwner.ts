import { createServiceClient } from '@/utils/supabase/service'

import { characterPortrait, type ShipOwner } from './shipHeading'

// The grantor account's main character, drawn as a shared item's owner when
// the share asks for it (character_asset_share.show_as_main): a player's alt
// may sit in the ship, but the ship is theirs, and it is their main they want
// seen. Null when the account has no main set, or the main is the holder, so
// the caller keeps the holder.
//
// Service role: a recipient cannot read another account's registration rows.
// Callers reach this only after the share itself has been verified (a signed
// link, or a share row the recipient's RLS lets them read), and it answers
// with nothing but the main's public name and portrait.
export const mainOwnerOf = async (holderRegistrationId: string): Promise<ShipOwner | null> => {
  const service = createServiceClient()
  const { data: holder } = await service
    .from('registration')
    .select('user_id')
    .eq('id', holderRegistrationId)
    .maybeSingle<{ user_id: string }>()
  if (!holder) return null
  const { data: main } = await service
    .from('registration')
    .select('id, name, character_id')
    .eq('user_id', holder.user_id)
    .eq('is_main', true)
    .maybeSingle<{ id: string; name: string; character_id: number | string | null }>()
  if (!main || main.id === holderRegistrationId) return null
  return { name: main.name, portrait: main.character_id == null ? null : characterPortrait(main.character_id) }
}
