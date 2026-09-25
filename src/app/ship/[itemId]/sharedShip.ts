import { cache } from 'react'

import { getSdeType, type SdeType } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { resolveShareParams } from '../../asset/access'
import { characterPortrait, corporationLogo, type ShipOwner } from './shipHeading'
import { SHIP_CATEGORY_ID, type ChildRow } from './shipRows'

// Everything a share link opens about a ship: the hull, what is inside it and
// who owns it. The share-link page draws it, and so does the link-preview card
// (./card) that Discord and other chat clients fetch. Both take it from here,
// so the preview can never show more than the link itself opens.
//
// The service-role client bypasses RLS, so every query below is filtered to
// the sharer's characters/corps from the resolved share scope. Location is
// never read: a share link says what the ship is, never where it is.

export type ShipRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

export type SharedShip = {
  self: ShipRow
  selfType: SdeType | undefined
  children: ChildRow[]
  owner: ShipOwner
  ownerId: string
  ownerKind: 'character' | 'corporation'
}

export type ShareParams = { token?: string; share?: string }

const loadSharedShip = async (itemId: string, share?: string, token?: string): Promise<SharedShip | null> => {
  const scope = await resolveShareParams({ share, token }, itemId)
  if (!scope) return null

  const supabase = createServiceClient()
  const corporationIds = scope.corporationIds.length > 0 ? scope.corporationIds : [-1]
  const { data: characterSelf } = await supabase
    .from('character_asset')
    .select('item_id, registration_id, type_id, name')
    .eq('item_id', itemId)
    .in('registration_id', scope.registrationIds)
    .maybeSingle<ShipRow>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id')
        .eq('item_id', itemId)
        .in('corporation_id', corporationIds)
        .maybeSingle<ShipRow>()
  const self = characterSelf ?? corpSelf
  if (!self) return null
  const selfType = await getSdeType(Number(self.type_id))
  // The share outlived the ship (sold, transferred, unlinked): dead link.
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) return null

  const [{ data: characterChildren }, { data: corpChildren }] = await Promise.all([
    supabase
      .from('character_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name')
      .eq('location_id', itemId)
      .in('registration_id', scope.registrationIds),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
      .eq('location_id', itemId)
      .in('corporation_id', corporationIds),
  ])
  const children = [...((characterChildren ?? []) as ChildRow[]), ...((corpChildren ?? []) as ChildRow[])]

  // Everything inside a ship belongs to whoever owns the ship, so the whole
  // cargo view carries a single owner.
  if (characterSelf?.registration_id) {
    // The share scope carries the sharer's name but not their EVE id, which is
    // what the portrait is keyed on — one lookup on the registration the scope
    // already vouched for.
    const { data: registration } = await supabase
      .from('registration')
      .select('character_id')
      .eq('id', characterSelf.registration_id)
      .maybeSingle<{ character_id: number | string | null }>()
    return {
      self,
      selfType,
      children,
      owner: {
        name: scope.characterNames.get(characterSelf.registration_id) ?? 'Unknown character',
        portrait: registration?.character_id == null ? null : characterPortrait(registration.character_id),
      },
      ownerId: characterSelf.registration_id,
      ownerKind: 'character',
    }
  }

  const corporationId = Number(corpSelf?.corporation_id)
  const { data: corpName } = await supabase
    .from('universe_name')
    .select('name')
    .eq('id', corporationId)
    .maybeSingle<{ name: string }>()
  return {
    self,
    selfType,
    children,
    owner: { name: corpName?.name ?? `Corporation #${corporationId}`, portrait: corporationLogo(corporationId) },
    ownerId: String(corporationId),
    ownerKind: 'corporation',
  }
}

// Per request: generateMetadata and the page both ask for the same ship while
// one share link renders, and React's cache() lets the second ask reuse the
// first answer. Primitive arguments, because cache() compares them by identity.
export const sharedShip = cache(loadSharedShip)
