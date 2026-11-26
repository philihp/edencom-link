import type { SupabaseClient } from '@supabase/supabase-js'

import { NO_FLAGS } from '../../asset/cloak'
import { recipientShareFlags } from '../../asset/shareFlags'
import { mainOwnerOf } from './mainOwner'
import { UNNAMED_OWNER } from './presentedOwner'
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
// holding it, asks for that, and no location when one cloaks it
// (../../asset/shareFlags.ts). The owner viewing their own ship always sees the
// true holder and place.

// hiddenHolder is the holding character's name when the page must not give
// that character away (a share showing the main): the caller strips it, and
// the holder's registration uuid, from everything it renders. Null otherwise.
// cloaked: a share covering the ship cloaks its location, so the page draws
// no place and no ship or container above it.
export type ShipOwnerView = { owner: ShipOwner; hiddenHolder: string | null; cloaked: boolean }

export const fetchShipOwner = async (
  supabase: SupabaseClient,
  characterSelf: OwnedRow | null,
  corpSelf: OwnedRow | null,
  itemId?: string
): Promise<ShipOwnerView> => {
  if (!characterSelf?.registration_id) {
    const corporationId = Number(corpSelf?.corporation_id)
    const { data: corpName } = await supabase
      .from('universe_name')
      .select('name')
      .eq('id', corporationId)
      .maybeSingle<{ name: string }>()
    return {
      owner: { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) },
      hiddenHolder: null,
      cloaked: false,
    }
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
  const flags =
    !registration && itemId ? await recipientShareFlags(supabase, characterSelf.registration_id, itemId) : NO_FLAGS
  if (flags.showAsMain) {
    // No main set still hides the holder: the share asked for that.
    const main = await mainOwnerOf(characterSelf.registration_id)
    if (!main?.isHolder)
      return { owner: main?.owner ?? UNNAMED_OWNER, hiddenHolder: directory?.name ?? '', cloaked: flags.cloakLocation }
  }
  const eveCharacterId = registration?.character_id ?? directory?.character_id ?? null
  return {
    owner: {
      name: registration?.name ?? directory?.name ?? 'Unknown character',
      portrait: eveCharacterId == null ? null : characterPortrait(eveCharacterId),
    },
    hiddenHolder: null,
    cloaked: flags.cloakLocation,
  }
}
