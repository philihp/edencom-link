import type { SupabaseClient } from '@supabase/supabase-js'

import { mainOwnerOf } from './mainOwner'
import { characterPortrait, corporationLogo, type ShipOwner } from './shipHeading'

// Who a hull belongs to, resolved the same way for every page that draws one:
// /ship, its share-link view, and the retiring embed page at /item. In its own
// module so the three can't drift — an owner that reads one way on one page and another
// way on the next is the kind of difference nobody notices until it matters.

// Only the two owner columns are read; a caller passes whichever hangar row it
// found the hull in.
export type OwnedRow = { registration_id?: string; corporation_id?: number | string }

// Owner: the holding character's name and portrait, or the corporation's
// cached name and logo. `character_id` here is the EVE numeric id (what the
// image server serves portraits for), not the registration uuid its sibling
// asset columns misname.
// A share recipient (the caller cannot read the holder's registration) sees
// the account's main instead when a share covering the ship, or anything
// holding it, asks for that. The share rows come through the recipient's own
// RLS, which returns only shares aimed at them; `itemId` is the ship, to find
// them by. The owner viewing their own ship always sees the true holder.
const sharedAsMain = async (supabase: SupabaseClient, registrationId: string, itemId: string): Promise<boolean> => {
  const { data: chain } = await supabase.rpc('asset_ancestors', { start_id: itemId })
  const itemIds = [itemId, ...((chain ?? []) as Array<{ item_id: number | string }>).map((row) => String(row.item_id))]
  const { data: shares } = await supabase
    .from('character_asset_share')
    .select('id')
    .eq('registration_id', registrationId)
    .eq('show_as_main', true)
    .in('item_id', itemIds)
    .limit(1)
  return (shares ?? []).length > 0
}

export const fetchShipOwner = async (
  supabase: SupabaseClient,
  characterSelf: OwnedRow | null,
  corpSelf: OwnedRow | null,
  itemId?: string
): Promise<ShipOwner> => {
  if (!characterSelf?.registration_id) {
    const corporationId = Number(corpSelf?.corporation_id)
    const { data: corpName } = await supabase
      .from('universe_name')
      .select('name')
      .eq('id', corporationId)
      .maybeSingle<{ name: string }>()
    return { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) }
  }

  // A shared ship's owner is outside the caller's registration view (RLS);
  // their public name resolves through the world-readable directory. Both are
  // probed together — only one of them can match.
  const [{ data: registration }, { data: directory }] = await Promise.all([
    supabase
      .from('registration')
      .select('name, character_id')
      .eq('id', characterSelf.registration_id)
      .maybeSingle<{ name: string; character_id: number | string | null }>(),
    supabase
      .from('character_directory')
      .select('name, character_id')
      .eq('registration_id', characterSelf.registration_id)
      .maybeSingle<{ name: string | null; character_id: number | string | null }>(),
  ])
  if (!registration && itemId && (await sharedAsMain(supabase, characterSelf.registration_id, itemId))) {
    const main = await mainOwnerOf(characterSelf.registration_id)
    if (main) return main
  }
  const eveCharacterId = registration?.character_id ?? directory?.character_id ?? null
  return {
    name: registration?.name ?? directory?.name ?? 'Unknown character',
    portrait: eveCharacterId == null ? null : characterPortrait(eveCharacterId),
  }
}
