import type { SupabaseClient } from '@supabase/supabase-js'

import { characterPortrait, corporationLogo, type ShipOwner } from './shipHeading'

// Who a hull belongs to, resolved the same way for every page that draws one:
// /ship, its share-link view, and the new /item viewer. In its own module so
// the three can't drift — an owner that reads one way on one page and another
// way on the next is the kind of difference nobody notices until it matters.

// Only the two owner columns are read; a caller passes whichever hangar row it
// found the hull in.
export type OwnedRow = { registration_id?: string; corporation_id?: number | string }

// Owner: the holding character's name and portrait, or the corporation's
// cached name and logo. `character_id` here is the EVE numeric id (what the
// image server serves portraits for), not the registration uuid its sibling
// asset columns misname.
export const fetchShipOwner = async (
  supabase: SupabaseClient,
  characterSelf: OwnedRow | null,
  corpSelf: OwnedRow | null
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
  const eveCharacterId = registration?.character_id ?? directory?.character_id ?? null
  return {
    name: registration?.name ?? directory?.name ?? 'Unknown character',
    portrait: eveCharacterId == null ? null : characterPortrait(eveCharacterId),
  }
}
