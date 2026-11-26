import { any, filter } from 'ramda'

import type { Crumb } from '../assetPath'

// A share can cloak the location of what it shares
// (character_asset_share.cloak_location): the pages then say where the item
// is no more than "Location cloaked", and draw no ship, container or place
// above it. Pure, so the rules are tested; ./shareFlags.ts reads the rows.

// What the pages show where the location would be.
export const CLOAKED_LOCATION = 'Location cloaked'

// The flags a recipient's view takes from the shares covering an item. Any
// covering share that asks for a flag sets it: the item and every container
// above it can each carry a share, and the strictest one wins.
export type ShareFlags = { showAsMain: boolean; cloakLocation: boolean }

export type ShareFlagRow = { show_as_main?: boolean | null; cloak_location?: boolean | null }

export const NO_FLAGS: ShareFlags = { showAsMain: false, cloakLocation: false }

const asks =
  (flag: keyof ShareFlagRow) =>
  (row: ShareFlagRow): boolean =>
    row[flag] === true

export const shareFlagsOf = (rows: ShareFlagRow[]): ShareFlags => ({
  showAsMain: any(asks('show_as_main'), rows),
  cloakLocation: any(asks('cloak_location'), rows),
})

// A breadcrumb with the location taken out: only the Assets root stays, so
// the page keeps its way back to the asset browser and says nothing about
// where the item is or what holds it.
const isAssetsRoot = (crumb: Crumb): boolean => crumb.href === '/asset'

export const cloakCrumbs = (crumbs: Crumb[]): Crumb[] => filter(isAssetsRoot, crumbs)
