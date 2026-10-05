import { map } from 'ramda'
import { cache } from 'react'

import { getSdeType, type SdeType } from '@/sdeTypes'
import { createServiceClient } from '@/utils/supabase/service'

import { resolveShareParams } from '../../asset/access'
import { latestPerItem, sightingOf, type Sighting } from './lastSeen'
import { mainOwnerOf } from './mainOwner'
import { hideHolder, PRESENTED_OWNER_ID, UNNAMED_OWNER } from './presentedOwner'
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
//
// A link outlives the ship: once the hull leaves the sharer's hangar (sold,
// moved, or the extract stopped seeing it), the newest version row is closed,
// and the page shows that version and what was aboard at the last extract
// that saw it (lastSeen.ts). Only a character's ship has that history here;
// a corp ship on a legacy token link still goes dead with its row.

export type ShipRow = {
  item_id: number | string
  type_id: number | string
  name: string | null
  registration_id?: string
  corporation_id?: number | string
}

type ShipVersionRow = ShipRow & { is_current: boolean; valid_until: string }

export type SharedShip = {
  self: ShipRow
  selfType: SdeType | undefined
  children: ChildRow[]
  owner: ShipOwner
  ownerId: string
  ownerKind: 'character' | 'corporation'
  sighting: Sighting
}

export type ShareParams = { token?: string; share?: string }

const CHILD_COLUMNS = 'item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy, name'

type Service = ReturnType<typeof createServiceClient>

// What was aboard at the last extract that saw the ship. The run that saw the
// ship gone closed it and everything aboard it with one clock in valid_until
// (the reconcile's own closes and the claim function's cross-owner close both
// stamp the run's `now`), so the contents are the rows linked to the ship with
// that stamp or a later one; rows closed by an earlier run hold an earlier one
// and drop out. Read from the version table, not the view: the view
// blanks a link to a parent with no open row, which a vanished ship is. The
// service role reads the table without RLS, and the scope filter stands in.
// Open rows are asked for separately, so each arm lands on its own partial
// index (current_location / history_location).
const childrenAsOf = async (supabase: Service, itemId: string, registrationIds: string[], lastSeen: string) => {
  const linked = () =>
    supabase
      .from('character_asset_version')
      .select(`${CHILD_COLUMNS}, is_current, valid_until`)
      .eq('location_id', itemId)
      .in('registration_id', registrationIds)
  const [{ data: open }, { data: closed }] = await Promise.all([
    linked().eq('is_current', true),
    linked().eq('is_current', false).gte('valid_until', lastSeen),
  ])
  type Row = ChildRow & { is_current: boolean; valid_until: string }
  return latestPerItem([...((open ?? []) as Row[]), ...((closed ?? []) as Row[])]) as ChildRow[]
}

// When the owner's assets were last pulled successfully: the newest
// character-assets (or corp-assets) heartbeat that ended ok for that owner.
// An open row's valid_until is its debut (the reconcile writes nothing to an
// unchanged row), so this is what "last seen" means for a ship still held.
// Null when no such run is on record; the caller then falls back to the row.
const lastAssetsRefresh = async (
  supabase: Service,
  owner: { job: string; column: 'registration_id' | 'corporation_id'; id: string | number }
): Promise<string | null> => {
  const { data } = await supabase
    .from('heartbeat')
    .select('ended_at')
    .eq('job', owner.job)
    .eq(owner.column, owner.id)
    .eq('ok', true)
    .not('ended_at', 'is', null)
    .order('ended_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ ended_at: string }>()
  return data?.ended_at ?? null
}

const loadSharedShip = async (itemId: string, share?: string, token?: string): Promise<SharedShip | null> => {
  const scope = await resolveShareParams({ share, token }, itemId)
  if (!scope) return null

  const supabase = createServiceClient()
  const corporationIds = scope.corporationIds.length > 0 ? scope.corporationIds : [-1]
  // The newest version, open or closed: the open one where the ship is in
  // the hangar, else the last one that was.
  const { data: characterSelf } = await supabase
    .from('character_asset_over_time')
    .select('item_id, registration_id, type_id, name, is_current, valid_until')
    .eq('item_id', itemId)
    .in('registration_id', scope.registrationIds)
    .order('is_current', { ascending: false })
    .order('valid_until', { ascending: false })
    .limit(1)
    .maybeSingle<ShipVersionRow>()
  const { data: corpSelf } = characterSelf
    ? { data: null }
    : await supabase
        .from('corp_asset')
        .select('item_id, corporation_id, type_id, is_current, valid_until')
        .eq('item_id', itemId)
        .in('corporation_id', corporationIds)
        .maybeSingle<ShipVersionRow>()
  const self = characterSelf ?? corpSelf
  if (!self) return null
  const selfType = await getSdeType(Number(self.type_id))
  // Not a ship: the share covers a container, and this page is for hulls.
  if (selfType?.categoryID !== SHIP_CATEGORY_ID) return null
  const sighting = sightingOf(
    self,
    self.is_current
      ? await lastAssetsRefresh(
          supabase,
          characterSelf
            ? { job: 'character-assets', column: 'registration_id', id: characterSelf.registration_id as string }
            : { job: 'corp-assets', column: 'corporation_id', id: Number(corpSelf!.corporation_id) }
        )
      : null
  )

  const [characterChildren, { data: corpChildren }] = await Promise.all([
    characterSelf && !characterSelf.is_current
      ? childrenAsOf(supabase, itemId, scope.registrationIds, characterSelf.valid_until)
      : supabase
          .from('character_asset')
          .select(CHILD_COLUMNS)
          .eq('location_id', itemId)
          .in('registration_id', scope.registrationIds)
          .then(({ data }) => (data ?? []) as ChildRow[]),
    supabase
      .from('corp_asset')
      .select('item_id, type_id, location_flag, quantity, is_singleton, is_blueprint_copy')
      .eq('location_id', itemId)
      .in('corporation_id', corporationIds),
  ])
  const children = [...characterChildren, ...((corpChildren ?? []) as ChildRow[])]

  // Everything inside a ship belongs to whoever owns the ship, so the whole
  // cargo view carries a single owner.
  if (characterSelf?.registration_id) {
    const holderName = scope.characterNames.get(characterSelf.registration_id) ?? null
    // The share may ask to show the account's main rather than the holder.
    // Then nothing below may lead back to the holder: not their uuid, not
    // their portrait, not a ship or item name that carries their name. The
    // card and the link preview read this same answer.
    const main = scope.showAsMain ? await mainOwnerOf(characterSelf.registration_id) : null
    if (scope.showAsMain && !main?.isHolder) {
      const hide = hideHolder(holderName)
      return {
        self: hide(self),
        selfType,
        children: map(hide, children),
        owner: main?.owner ?? UNNAMED_OWNER,
        ownerId: PRESENTED_OWNER_ID,
        ownerKind: 'character',
        sighting,
      }
    }
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
        name: holderName ?? 'Unknown character',
        portrait: registration?.character_id == null ? null : characterPortrait(registration.character_id),
      },
      ownerId: characterSelf.registration_id,
      ownerKind: 'character',
      sighting,
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
    sighting,
  }
}

// Per request: generateMetadata and the page both ask for the same ship while
// one share link renders, and React's cache() lets the second ask reuse the
// first answer. Primitive arguments, because cache() compares them by identity.
export const sharedShip = cache(loadSharedShip)
