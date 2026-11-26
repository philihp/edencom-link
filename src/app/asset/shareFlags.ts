import type { SupabaseClient } from '@supabase/supabase-js'

import { type ShareFlags, shareFlagsOf, type ShareFlagRow } from './cloak'

// The flags a share recipient's view of a character's item obeys: show the
// account's main as the owner (show_as_main), and cloak the location
// (cloak_location). Read on the recipient's own session: RLS returns only the
// share rows aimed at them, and asset_ancestors() climbs only as far as they
// can see, so the candidates are the item and the containers above it inside
// the share. `registrationId` is the holder, whose account's rows count. The
// owner's own view never asks: they always see the true holder and place.
export const recipientShareFlags = async (
  supabase: SupabaseClient,
  registrationId: string,
  itemId: string
): Promise<ShareFlags> => {
  const { data: chain } = await supabase.rpc('asset_ancestors', { start_id: itemId })
  const itemIds = [itemId, ...((chain ?? []) as Array<{ item_id: number | string }>).map((row) => String(row.item_id))]
  const { data: shares } = await supabase
    .from('character_asset_share')
    .select('show_as_main, cloak_location')
    .eq('registration_id', registrationId)
    .in('item_id', itemIds)
    .or('show_as_main.eq.true,cloak_location.eq.true')
  return shareFlagsOf((shares ?? []) as ShareFlagRow[])
}
