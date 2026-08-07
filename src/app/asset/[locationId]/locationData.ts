import type { SupabaseClient } from '@supabase/supabase-js'

// The shapes and the root-item query shared by the location page and the
// sections it streams. It lives in its own module so those can't end up
// importing each other.

// invGroups.categoryID for the Ship category in CCP's SDE.
export const SHIP_CATEGORY_ID = 6

// Bigint ids arrive from PostgREST as strings; keep them as strings and only
// convert at the API/system-lookup boundary (mirrors the assets index page).
export type CharacterAsset = {
  item_id: number | string
  registration_id: string
  type_id: number | string
  location_id: number | string | null
  location_flag: string | null
  location_type: string | null
  quantity: number | string | null
  is_singleton: boolean | null
  is_blueprint_copy: boolean | null
  name: string | null
}

// Corp assets carry no player-assigned name column; owner is the corporation.
export type CorpAsset = Omit<CharacterAsset, 'registration_id' | 'name'> & { corporation_id: number | string }

// Either source's row, normalized to whoever owns it: a character
// (registration uuid) or a corporation (EVE corporation id).
export type Asset = Omit<CharacterAsset, 'registration_id'> & { owner_id: string }

// Root-level assets at this location: ships, containers and loose stacks that
// sit directly in the station/structure/system (not nested in another item),
// from both the character and corp hangars. Only this level is fetched — the
// whole asset table no longer pages into Node.
export const fetchRootItems = async (
  supabase: SupabaseClient,
  locationId: string,
  characterScope: string[] | null,
  corpScope: number[] | null
): Promise<{ rootItems: Asset[]; currentShipItemIds: Set<string> }> => {
  let characterQuery = supabase
    .from('character_asset')
    .select(
      'item_id, registration_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_blueprint_copy, name'
    )
    .eq('location_id', locationId)
  if (characterScope) characterQuery = characterQuery.in('registration_id', characterScope)
  let corpQuery = supabase
    .from('corp_asset')
    .select(
      'item_id, corporation_id, type_id, location_id, location_flag, location_type, quantity, is_singleton, is_blueprint_copy'
    )
    .eq('location_id', locationId)
  if (corpScope) corpQuery = corpQuery.in('corporation_id', corpScope)
  // A character's currently-piloted ship reports its location as wherever it's
  // docked — physically indistinguishable from any other ship parked there —
  // so it otherwise shows up as an ordinary item in that station's listing.
  // Still shown (it belongs here from the DB's point of view), but flagged so
  // the UI can tell it apart from a ship that's merely parked.
  let currentShipQuery = supabase.from('character_ship').select('ship_item_id')
  if (characterScope) currentShipQuery = currentShipQuery.in('registration_id', characterScope)

  const [{ data: characterChildren }, { data: corpChildren }, { data: currentShips }] = await Promise.all([
    characterQuery,
    corpQuery,
    currentShipQuery,
  ])

  return {
    rootItems: [
      ...((characterChildren ?? []) as CharacterAsset[]).map(({ registration_id, ...a }) => ({
        ...a,
        owner_id: registration_id,
      })),
      ...((corpChildren ?? []) as CorpAsset[]).map(({ corporation_id, ...a }) => ({
        ...a,
        owner_id: String(corporation_id),
        name: null,
      })),
    ],
    currentShipItemIds: new Set(
      ((currentShips ?? []) as { ship_item_id: number | string }[]).map((s) => String(s.ship_item_id))
    ),
  }
}
