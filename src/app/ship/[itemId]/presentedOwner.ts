import { includes, toLower } from 'ramda'

import type { ShipOwner } from './shipHeading'

// A share can show the account's main as a ship's owner
// (character_asset_share.show_as_main). Then nothing the page or the card
// sends may lead to the character really holding the ship: people run
// locators on character names. Pure, so the rules are tested.

// The owner id every row carries instead of the holder's registration uuid.
// character_directory is world-readable and maps a registration uuid to its
// character, so the uuid names the holder as surely as the name does.
export const PRESENTED_OWNER_ID = 'owner'

// The owner drawn when the share asks for the main but the account has no
// main set. The holder stays hidden: the share asked for that.
export const UNNAMED_OWNER: ShipOwner = { name: 'Private owner', portrait: null }

// An item name that contains the holder's name reads as null, so the page and
// the card fall back to the type name. EVE names a new hull "<pilot>'s <hull>",
// and players keep that name more often than not.
export const withoutHolderName =
  (holderName: string | null | undefined) =>
  (name: string | null | undefined): string | null => {
    if (name == null) return null
    const holder = holderName?.trim()
    if (!holder) return name
    return includes(toLower(holder), toLower(name)) ? null : name
  }

// One asset row as a recipient may see it when the main is shown: no holder
// uuid (the ship page keys rows by registration_id, the asset browser by
// owner_id), and no name that gives the holder away.
export const hideHolder =
  (holderName: string | null | undefined) =>
  <T extends { name?: string | null; registration_id?: string; owner_id?: string }>(row: T): T => ({
    ...row,
    name: withoutHolderName(holderName)(row.name),
    ...(row.registration_id === undefined ? {} : { registration_id: PRESENTED_OWNER_ID }),
    ...(row.owner_id === undefined ? {} : { owner_id: PRESENTED_OWNER_ID }),
  })

// A breadcrumb label (a container above the ship) that contains the holder's
// name. A crumb needs some text, so it reads as a plain "Container".
export const labelWithoutHolder =
  (holderName: string | null | undefined) =>
  (label: string): string =>
    withoutHolderName(holderName)(label) ?? 'Container'
